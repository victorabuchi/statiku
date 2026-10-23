import Foundation
import Testing
@testable import Statiku

/// Answers every request with `status` (nil: no answer) and keeps what was sent.
final class FakeTransport: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [URLRequest] = []
    private var answer: Int? = 202

    var status: Int? {
        get { lock.withLock { answer } }
        set { lock.withLock { answer = newValue } }
    }

    var requests: [URLRequest] { lock.withLock { sent } }

    var bodies: [[String: Any]] {
        requests.map { (try? JSONSerialization.jsonObject(with: $0.httpBody ?? Data())) as? [String: Any] ?? [:] }
    }

    var eventNames: [[String]] {
        bodies.map { ($0["events"] as? [[String: Any]] ?? []).map { $0["name"] as? String ?? "" } }
    }

    func send(_ request: URLRequest, completion: @escaping @Sendable (Int?) -> Void) {
        let status = lock.withLock {
            sent.append(request)
            return answer
        }
        completion(status)
    }
}

let endpoint = URL(string: "https://ingest.example")!
let mac = Device(platform: "macOS", osVersion: "26.1", appVersion: "1.5", build: "6")

func freshDefaults() -> UserDefaults { UserDefaults(suiteName: "statiku-tests-\(UUID().uuidString)")! }

func client(_ transport: FakeTransport, _ defaults: UserDefaults = freshDefaults(), device: Device = mac, now: Date = Date()) -> Client {
    let c = Client(defaults: defaults, transport: transport, device: device)
    c.queue.sync {
        // Only an explicit flush sends, so each test decides when.
        c.flushDelay = 3600
        c.now = { now }
    }
    return c
}

extension Client {
    /// Sends what's waiting and waits for the answers, which come back on the queue.
    func flushAndWait() {
        flush()
        for _ in 0..<20 { queue.sync {} }
    }

    var waiting: Int { queue.sync { pending.count } }
}

@Test func firstLaunchSendsTheInstallAndTheDay() throws {
    let t = FakeTransport()
    let c = client(t)
    c.start(project: "p_test", endpoint: endpoint)
    c.setState(.trial)
    c.flushAndWait()

    // One batch per state: the launch before the app said it's in trial, then the change.
    #expect(t.eventNames == [["install", "active"], ["state"]])
    let request = try #require(t.requests.first)
    #expect(request.url?.absoluteString == "https://ingest.example/v1/app")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    let first = t.bodies[0], second = t.bodies[1]
    #expect(first["project"] as? String == "p_test")
    #expect(first["platform"] as? String == "macOS")
    #expect(first["osVersion"] as? String == "26.1")
    #expect(first["appVersion"] as? String == "1.5")
    #expect(first["build"] as? String == "6")
    #expect(first["state"] == nil)
    let install = try #require(first["install"] as? String)
    #expect(UUID(uuidString: install) != nil && install == install.lowercased())
    #expect(second["install"] as? String == install)
    #expect(second["state"] as? String == "trial")
    let event = try #require((second["events"] as? [[String: Any]])?.first)
    #expect(event["props"] as? [String: String] == ["to": "trial"])
    #expect((event["at"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) } != nil)
    #expect(c.waiting == 0)
}

@Test func laterLaunchesSendUpdatesAndNewDaysOnly() {
    let defaults = freshDefaults()
    let t = FakeTransport()
    // A launch that quits before sending: its events wait in the preferences for the next one.
    let first = client(t, defaults)
    first.start(project: "p_test", endpoint: endpoint)
    first.queue.sync {}
    let today = client(t, defaults)
    today.start(project: "p_test", endpoint: endpoint)
    today.flushAndWait()
    #expect(t.eventNames == [["install", "active"]])

    let updated = client(t, defaults, device: Device(platform: "macOS", osVersion: "26.1", appVersion: "1.6", build: "7"))
    updated.start(project: "p_test", endpoint: endpoint)
    updated.setState(.licensed)
    updated.setState(.licensed)
    updated.flushAndWait()
    let tomorrow = client(t, defaults, device: Device(platform: "macOS", osVersion: "26.2", appVersion: "1.6", build: "7"), now: Date().addingTimeInterval(86400))
    tomorrow.start(project: "p_test", endpoint: endpoint)
    tomorrow.flushAndWait()

    #expect(t.eventNames == [["install", "active"], ["update"], ["state"], ["active"]])
    let bodies = t.bodies
    #expect(Set(bodies.map { $0["install"] as? String }).count == 1)
    #expect((bodies[1]["events"] as? [[String: Any]])?.first?["props"] as? [String: String] == ["from": "1.5"])
    #expect(bodies[3]["state"] as? String == "licensed")
    #expect(bodies[3]["osVersion"] as? String == "26.2")
}

@Test func failedBatchesWaitAndSurviveARestart() {
    let defaults = freshDefaults()
    let t = FakeTransport()
    t.status = nil
    let c = client(t, defaults)
    c.start(project: "p_test", endpoint: endpoint)
    c.flushAndWait()
    #expect(t.requests.count == 1)
    #expect(c.waiting == 2)
    // The next try waits; a new event doesn't hurry it.
    c.track("export", ["format": "png"])
    c.queue.sync { c.send() }
    #expect(t.requests.count == 1)

    // After a restart they're still there and go when the service answers.
    t.status = 503
    let restarted = client(t, defaults)
    #expect(restarted.waiting == 3)
    restarted.start(project: "p_test", endpoint: endpoint)
    restarted.flushAndWait()
    #expect(restarted.waiting == 3)
    t.status = 202
    restarted.flushAndWait()
    #expect(restarted.waiting == 0)
    #expect(t.eventNames.last == ["install", "active", "export"])

    // Refused for good (a wrong key): dropped, not retried forever.
    t.status = 404
    restarted.track("export")
    restarted.flushAndWait()
    #expect(restarted.waiting == 0)
}

@Test func batchesHoldAtMostAHundredEventsAndTheQueueFiveHundred() {
    let t = FakeTransport()
    let c = client(t)
    c.start(project: "p_test", endpoint: endpoint)
    for i in 0..<600 { c.track("tick", ["i": .int(i)]) }
    #expect(c.waiting == 500)
    c.flushAndWait()
    #expect(t.eventNames.map(\.count) == [100, 100, 100, 100, 100])
    #expect(t.eventNames.first?.first == "tick")
    // The oldest were dropped, the install and the day among them, and the rest went in order.
    #expect((t.bodies.last?["events"] as? [[String: Any]])?.last?["props"] as? [String: Int] == ["i": 599])
}

@Test func optingOutStopsEverythingAndForgetsTheInstall() throws {
    let defaults = freshDefaults()
    let t = FakeTransport()
    let c = client(t, defaults)
    c.start(project: "p_test", endpoint: endpoint)
    c.flushAndWait()
    let before = try #require(t.bodies.first?["install"] as? String)

    c.track("export")
    c.setOptedOut(true)
    #expect(c.optedOut)
    c.track("export")
    c.setState(.licensed)
    let buy = URL(string: "https://buy.polar.sh/polar_cl_abc")!
    #expect(c.checkoutURL(buy) == buy)
    c.flushAndWait()
    #expect(t.requests.count == 1)
    #expect(c.waiting == 0)
    #expect(defaults.string(forKey: Key.install) == nil)

    c.setOptedOut(false)
    c.flushAndWait()
    #expect(t.eventNames.last == ["install", "active"])
    #expect(t.bodies.last?["install"] as? String != before)
}

@Test func checkoutLinksCarryAReference() throws {
    let t = FakeTransport()
    let c = client(t)
    c.start(project: "p_test", endpoint: endpoint)
    let query = { (url: URL) in Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }) }

    let polar = c.checkoutURL(URL(string: "https://buy.polar.sh/polar_cl_abc?discount_code=LAUNCH")!)
    let ref = try #require(query(polar)["reference_id"])
    #expect(ref.hasPrefix("stk_") && ref.count == 24)
    #expect(query(polar)["discount_code"] == "LAUNCH")
    #expect(query(c.checkoutURL(URL(string: "https://buy.stripe.com/test_abc")!))["client_reference_id"]?.hasPrefix("stk_") == true)
    #expect(query(c.checkoutURL(URL(string: "https://buy.polar.sh/x?reference_id=mine")!))["reference_id"] == "mine")
    let other = URL(string: "https://notchlight.com/buy")!
    #expect(c.checkoutURL(other) == other)

    c.flushAndWait()
    let events = (t.bodies.first?["events"] as? [[String: Any]]) ?? []
    let refs = events.filter { $0["name"] as? String == "checkout" }.map { ($0["props"] as? [String: String])?["ref"] }
    #expect(refs.count == 3 && refs.first == ref && refs.last == "mine")
}

@Test func propsKeepTheirTypes() throws {
    let props: [String: Value] = ["s": "png", "i": 3, "d": 1.5, "b": true, "x": "\(2) files"]
    let data = try JSONEncoder().encode(props)
    #expect(try JSONDecoder().decode([String: Value].self, from: data) == props)
    #expect(try JSONSerialization.jsonObject(with: data) as? NSDictionary == ["s": "png", "i": 3, "d": 1.5, "b": true, "x": "2 files"])
}

/// Sends through URLSession and keeps each status.
final class Recording: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [Int?] = []
    var statuses: [Int?] { lock.withLock { answers } }

    func send(_ request: URLRequest, completion: @escaping @Sendable (Int?) -> Void) {
        URLSessionTransport().send(request) { status in
            self.lock.withLock { self.answers.append(status) }
            completion(status)
        }
    }
}

/// Against a running ingest service: STATIKU_TEST_ENDPOINT=http://localhost:8787 STATIKU_TEST_PROJECT=p_… swift test
@Test(.enabled(if: ProcessInfo.processInfo.environment["STATIKU_TEST_ENDPOINT"] != nil))
func liveService() async throws {
    let env = ProcessInfo.processInfo.environment
    let defaults = freshDefaults()
    let transport = Recording()
    let c = Client(defaults: defaults, transport: transport, device: Device(platform: "macOS", osVersion: "26.1", appVersion: "1.6", build: "7"))
    c.start(project: try #require(env["STATIKU_TEST_PROJECT"]), endpoint: try #require(URL(string: env["STATIKU_TEST_ENDPOINT"] ?? "")))
    c.setState(.trial)
    c.track("export", ["format": "png", "count": 2])
    c.flush()
    for _ in 0..<100 where c.queue.sync(execute: { !c.pending.isEmpty || c.sending }) {
        try await Task.sleep(for: .milliseconds(100))
    }
    #expect(c.waiting == 0)
    #expect(!transport.statuses.isEmpty && transport.statuses.allSatisfy { $0 == 202 })
    print("Statiku live test install:", defaults.string(forKey: Key.install) ?? "none")
}
