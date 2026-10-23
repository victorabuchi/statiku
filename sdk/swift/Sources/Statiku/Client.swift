// Events wait in the app's preferences, so they survive a quit or a day offline, and go to the service in batches a
// few seconds after they happen. A batch that fails is tried again later, waiting longer each time, up to an hour.
import Foundation

/// Sends a request and reports its status, or nil when there was no answer. Tests use their own.
protocol Transport: Sendable {
    func send(_ request: URLRequest, completion: @escaping @Sendable (Int?) -> Void)
}

struct URLSessionTransport: Transport {
    func send(_ request: URLRequest, completion: @escaping @Sendable (Int?) -> Void) {
        URLSession.shared.dataTask(with: request) { _, response, _ in
            completion((response as? HTTPURLResponse)?.statusCode)
        }.resume()
    }
}

/// The app and the system it runs on: only the platform, the versions and the build.
struct Device: Sendable {
    var platform: String
    var osVersion: String
    var appVersion: String?
    var build: String?

    static var current: Device {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let info = Bundle.main.infoDictionary
        return Device(
            platform: platform,
            osVersion: "\(v.majorVersion).\(v.minorVersion)" + (v.patchVersion > 0 ? ".\(v.patchVersion)" : ""),
            appVersion: info?["CFBundleShortVersionString"] as? String,
            build: info?["CFBundleVersion"] as? String
        )
    }

    private static var platform: String {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return "macOS"
        #elseif os(visionOS)
        return "visionOS"
        #elseif os(iOS)
        if ProcessInfo.processInfo.isiOSAppOnMac { return "macOS" }
        return model.hasPrefix("iPad") ? "iPadOS" : "iOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #else
        return "Other"
        #endif
    }

    #if os(iOS)
    // "iPhone17,1" or "iPad16,3"; the simulator says which device it plays.
    private static var model: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
    #endif
}

struct Event: Codable, Equatable {
    var name: String
    var at: Date
    var props: [String: Value]?
}

/// An event waiting to be sent, with the licence state when it happened. A batch holds events of one state.
struct Pending: Codable {
    var seq: UInt64
    var state: LicenseState?
    var event: Event
}

/// The body of POST /v1/app.
struct Batch: Encodable {
    var project: String
    var install: String
    var platform: String
    var osVersion: String
    var appVersion: String?
    var build: String?
    var state: LicenseState?
    var events: [Event]
}

enum Key {
    static let install = "statiku.install"
    static let pending = "statiku.pending"
    static let activeDay = "statiku.activeDay"
    static let version = "statiku.version"
    static let state = "statiku.state"
    static let optedOut = "statiku.optedOut"
}

final class Client: @unchecked Sendable {
    static let shared = Client(defaults: .standard, transport: URLSessionTransport(), device: .current)

    static let maxPending = 500
    static let maxBatch = 100
    static let checkoutHosts = ["buy.polar.sh": "reference_id", "buy.stripe.com": "client_reference_id"]

    let defaults: UserDefaults
    let transport: Transport
    let device: Device
    let queue = DispatchQueue(label: "com.statiku.client")
    let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    // Everything below is used on `queue` only.
    var now: () -> Date = Date.init
    var flushDelay: TimeInterval = 5
    var project: String?
    var endpoint: URL?
    var pending: [Pending] = []
    var seq: UInt64 = 0
    var sending = false
    var flushScheduled = false
    var failures = 0
    var retryAt: Date?
    var timer: DispatchSourceTimer?

    init(defaults: UserDefaults, transport: Transport, device: Device) {
        self.defaults = defaults
        self.transport = transport
        self.device = device
        if let data = defaults.data(forKey: Key.pending), let saved = try? JSONDecoder.iso8601.decode([Pending].self, from: data) {
            pending = saved
            seq = saved.last?.seq ?? 0
        }
    }

    var optedOut: Bool { defaults.bool(forKey: Key.optedOut) }

    func start(project: String, endpoint: URL) {
        queue.async {
            self.project = project
            self.endpoint = endpoint
            self.launch()
            self.startTimer()
            self.scheduleFlush(after: self.flushDelay)
        }
    }

    // The first launch is an install, a new version an update, and the first launch of each day counts it as active.
    private func launch() {
        guard !optedOut else { return }
        if defaults.string(forKey: Key.install) == nil {
            defaults.set(UUID().uuidString.lowercased(), forKey: Key.install)
            enqueue("install")
        } else if let last = defaults.string(forKey: Key.version), let current = device.appVersion, last != current {
            enqueue("update", ["from": .string(last)])
        }
        if let current = device.appVersion { defaults.set(current, forKey: Key.version) }
        markActive()
    }

    private func markActive() {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: now())
        let day = "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
        guard defaults.string(forKey: Key.activeDay) != day else { return }
        defaults.set(day, forKey: Key.activeDay)
        enqueue("active")
    }

    // An app that stays open for weeks still counts each day, and sends what failed earlier.
    private func startTimer() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(wallDeadline: .now() + 3600, repeating: 3600)
        t.setEventHandler { [weak self] in
            guard let self, !self.optedOut else { return }
            self.markActive()
            self.send()
        }
        t.resume()
        timer = t
    }

    func track(_ name: String, _ props: [String: Value] = [:]) {
        queue.async { self.enqueue(name, props) }
    }

    func setState(_ state: LicenseState) {
        queue.async {
            guard !self.optedOut else { return }
            let old = self.defaults.string(forKey: Key.state)
            guard old != state.rawValue else { return }
            self.defaults.set(state.rawValue, forKey: Key.state)
            var props: [String: Value] = ["to": .string(state.rawValue)]
            if let old { props["from"] = .string(old) }
            self.enqueue("state", props)
        }
    }

    func checkoutURL(_ url: URL) -> URL {
        guard !optedOut, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "https",
              let param = parts.host.flatMap({ Client.checkoutHosts[$0] })
        else { return url }
        var items = parts.queryItems ?? []
        let ref = items.first { $0.name == param }?.value ?? "stk_" + String((0..<20).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        items.removeAll { $0.name == param }
        items.append(URLQueryItem(name: param, value: ref))
        parts.queryItems = items
        track("checkout", ["ref": .string(ref)])
        return parts.url ?? url
    }

    func setOptedOut(_ value: Bool) {
        guard value != optedOut else { return }
        defaults.set(value, forKey: Key.optedOut)
        queue.async {
            if value {
                self.pending.removeAll()
                self.save()
                for key in [Key.install, Key.activeDay] { self.defaults.removeObject(forKey: key) }
            } else if self.project != nil {
                self.launch()
            }
        }
    }

    func flush() {
        queue.async {
            self.retryAt = nil
            self.send()
        }
    }

    // MARK: Sending

    func enqueue(_ name: String, _ props: [String: Value] = [:]) {
        guard !optedOut, !name.isEmpty else { return }
        seq += 1
        let state = defaults.string(forKey: Key.state).flatMap(LicenseState.init(rawValue:))
        pending.append(Pending(seq: seq, state: state, event: Event(name: name, at: now(), props: props.isEmpty ? nil : props)))
        if pending.count > Client.maxPending { pending.removeFirst(pending.count - Client.maxPending) }
        save()
        scheduleFlush(after: flushDelay)
    }

    private func save() {
        defaults.set(try? encoder.encode(pending), forKey: Key.pending)
    }

    private func scheduleFlush(after delay: TimeInterval) {
        guard !flushScheduled else { return }
        flushScheduled = true
        queue.asyncAfter(deadline: .now() + delay) {
            self.flushScheduled = false
            self.send()
        }
    }

    func send() {
        if let retryAt, retryAt > now() { return scheduleFlush(after: retryAt.timeIntervalSince(now())) }
        guard !sending, !optedOut, let project, let endpoint, let install = defaults.string(forKey: Key.install),
              let first = pending.first
        else { return }
        let run = pending.prefix { $0.state == first.state }.prefix(Client.maxBatch)
        let batch = Batch(
            project: project, install: install, platform: device.platform, osVersion: device.osVersion,
            appVersion: device.appVersion, build: device.build, state: first.state, events: run.map(\.event)
        )
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/app"))
        request.httpMethod = "POST"
        request.httpBody = try? encoder.encode(batch)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        let last = run.last!.seq
        sending = true
        transport.send(request) { status in
            self.queue.async { self.sent(through: last, status: status) }
        }
    }

    private func sent(through last: UInt64, status: Int?) {
        sending = false
        if let status, status < 500, status != 408, status != 429 {
            // Taken, or refused for good (such as a mistyped project key): either way these don't go again.
            failures = 0
            retryAt = nil
            pending.removeAll { $0.seq <= last }
            save()
            send()
        } else {
            failures += 1
            let wait = min(60 * pow(2, Double(failures - 1)), 3600)
            retryAt = now().addingTimeInterval(wait)
            scheduleFlush(after: wait)
        }
    }
}

extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
