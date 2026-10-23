// Statiku for apps: an anonymous install, the days it's used, its versions, its trial or licence, and your own
// events. The install is a random ID kept in the app's preferences; nothing about the person or the Mac is sent.
//
//   Statiku.start(project: "p_…")
//   Statiku.setState(.trial)
//   Statiku.track("export", ["format": "png"])
//   NSWorkspace.shared.open(Statiku.checkoutURL(buyURL))
//   Statiku.isOptedOut = true
import Foundation

public enum Statiku {
    /// The Statiku service. Pass another to `start` to send events elsewhere, such as through your own domain.
    public static let defaultEndpoint = URL(string: "https://statiku-ingest.onrender.com")!

    /// Starts Statiku. Call it once, early in launch. The first launch sends `install`, each day the app runs sends
    /// `active`, and a new version sends `update`.
    public static func start(project: String, endpoint: URL = defaultEndpoint) {
        Client.shared.start(project: project, endpoint: endpoint)
    }

    /// Sends one of your own events, with up to 30 props.
    public static func track(_ name: String, _ props: [String: Value] = [:]) {
        Client.shared.track(name, props)
    }

    /// The app's licence: `.trial` while a free trial runs, `.expired` after it, `.licensed` once bought, `.free`
    /// for a free app or tier. Call it whenever it may have changed; a change sends `state`.
    public static func setState(_ state: LicenseState) {
        Client.shared.setState(state)
    }

    /// A Polar or Stripe checkout link with a reference added, and a `checkout` event with the same reference, so the
    /// payment's webhook can be credited to this install's source. Other links come back as they are.
    public static func checkoutURL(_ url: URL) -> URL {
        Client.shared.checkoutURL(url)
    }

    /// When true, nothing is sent, and the install ID and anything waiting are deleted. Offer it in your settings.
    /// Opting back in starts a new install.
    public static var isOptedOut: Bool {
        get { Client.shared.optedOut }
        set { Client.shared.setOptedOut(newValue) }
    }

    /// Sends what's waiting now instead of within a few seconds.
    public static func flush() {
        Client.shared.flush()
    }
}

public enum LicenseState: String, Codable, Sendable {
    case free, trial, expired, licensed
}

/// A prop's value: text, a whole number, a number or true or false, written as a literal (`["count": 3]`) or as
/// `.string(name)`.
public enum Value: Codable, Equatable, Sendable, ExpressibleByStringInterpolation, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral
{
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        }
    }
}
