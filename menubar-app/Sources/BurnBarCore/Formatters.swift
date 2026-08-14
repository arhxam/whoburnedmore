import Foundation

/// Pure display helpers — unit-tested in BurnBarCoreTests.
public enum Formatters {
    /// 999 → "999", 1_234 → "1.2K", 3_400_000 → "3.4M", 2_864_722_751 → "2.9B".
    /// Trailing ".0" is dropped ("2K", not "2.0K"). Promotes across unit
    /// boundaries when rounding tips it over (999_950_000 → "1B", not "1000M").
    public static func compactTokens(_ n: Int) -> String {
        let sign = n < 0 ? "-" : ""
        // `abs(Int.min)` traps (its magnitude overflows Int); clamp to Int.max.
        let v = n == Int.min ? Double(Int.max) : Double(abs(n))
        let units: [(Double, String)] = [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")]
        for (i, unit) in units.enumerated() {
            guard v >= unit.0 else { continue }
            var scaled = (v / unit.0 * 10).rounded() / 10
            var suffix = unit.1
            if scaled >= 1000, i > 0 {
                // rounding pushed it into the next unit (999.95M → "1000M" → "1B")
                let up = units[i - 1]
                scaled = (v / up.0 * 10).rounded() / 10
                suffix = up.1
            }
            let s = scaled.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(scaled))
                : String(format: "%.1f", scaled)
            return "\(sign)\(s)\(suffix)"
        }
        return "\(sign)\(Int(v))"
    }

    public static func usd(_ v: Double) -> String {
        v >= 100 ? String(format: "$%.0f", v) : String(format: "$%.2f", v)
    }

    /// A limit may briefly report above 100 after the provider has exhausted it.
    /// Keep the raw value for alerting, but never render more than 100% to users.
    public static func percent(_ value: Double?) -> String? {
        guard let value, value.isFinite else { return nil }
        return "\(Int(min(max(value, 0), 100).rounded()))%"
    }

    /// "2h 14m", "14m", "38s"; nil → "—", past/zero → "now".
    public static func countdown(to date: Date?, from now: Date = Date()) -> String {
        guard let date else { return "—" }
        let s = Int(date.timeIntervalSince(now).rounded())
        if s <= 0 { return "now" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        let dayH = 24
        if h < dayH { return "\(h)h \(m % 60)m" }
        return "\(h / dayH)d \(h % dayH)h"
    }

    /// Provider APIs can keep returning the last pre-reset snapshot until their
    /// next network poll. Once the advertised boundary passes, the old pressure
    /// is no longer truthful: treat a known percentage as reset locally.
    public static func effectiveLimitPercent(
        _ value: Double?, resetAt: Date?, now: Date = Date()
    ) -> Double? {
        guard value != nil else { return nil }
        guard let resetAt, resetAt <= now else { return value }
        return 0
    }

    /// Expired countdowns disappear instead of sitting at "now" for an entire
    /// remote refresh interval.
    public static func futureReset(_ resetAt: Date?, now: Date = Date()) -> Date? {
        guard let resetAt, resetAt > now else { return nil }
        return resetAt
    }

    /// ISO8601 with or without fractional seconds (the usage endpoint mixes both).
    public static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }
}

/// Menu-bar meter state; drives icon tint + compact text.
public enum MeterState: String, Equatable, Sendable {
    case normal
    case amber
    case critical

    /// amber at >=80, critical at >=95 (95+ is effectively a lockout countdown).
    public init(percent: Double?) {
        switch percent {
        case .some(let p) where p >= 95: self = .critical
        case .some(let p) where p >= 80: self = .amber
        default: self = .normal
        }
    }

    /// The tightest (worst) window across providers decides the menu bar state.
    public static func worst(of percents: [Double?]) -> MeterState {
        MeterState(percent: percents.compactMap { $0 }.max())
    }

    public var iconName: String {
        self == .normal ? "flame" : "flame.fill"
    }
}

/// What the status item shows next to the icon.
public enum MenuBarTextMode: String, CaseIterable, Sendable {
    case sessionStatus // "53% · 3h28m" — Claude 5h window + reset countdown (default)
    case todayTokens
    case limitPercent
    case todayCost
    case tokensPlusLimit // "147.7M · 53%"
    case iconOnly

    public struct Inputs {
        public let summary: Summary?
        public let worstPercent: Double?
        public let sessionPercent: Double?
        public let sessionReset: Date?
        public let now: Date

        public init(
            summary: Summary?,
            worstPercent: Double?,
            sessionPercent: Double? = nil,
            sessionReset: Date? = nil,
            now: Date = Date()
        ) {
            self.summary = summary
            self.worstPercent = worstPercent
            self.sessionPercent = sessionPercent
            self.sessionReset = sessionReset
            self.now = now
        }
    }

    public func text(_ i: Inputs) -> String? {
        switch self {
        case .sessionStatus:
            // Fall back through worst limit, then tokens, so the bar is never blank.
            if let p = i.sessionPercent {
                let pct = Formatters.percent(p) ?? "0%"
                if let reset = i.sessionReset {
                    return "\(pct) · \(Formatters.countdown(to: reset, from: i.now))"
                }
                return pct
            }
            if let p = i.worstPercent { return Formatters.percent(p) }
            return i.summary.map { Formatters.compactTokens($0.today.totalTokens) }
        case .todayTokens:
            guard let t = i.summary?.today.totalTokens else { return nil }
            return Formatters.compactTokens(t)
        case .limitPercent:
            guard let p = i.worstPercent else { return nil }
            return Formatters.percent(p)
        case .todayCost:
            guard let c = i.summary?.today.costUSD else { return nil }
            return Formatters.usd(c)
        case .tokensPlusLimit:
            let tokens = i.summary.map { Formatters.compactTokens($0.today.totalTokens) }
            let pct = Formatters.percent(i.worstPercent)
            switch (tokens, pct) {
            case let (.some(t), .some(p)): return "\(t) · \(p)"
            case let (.some(t), nil): return t
            case let (nil, .some(p)): return p
            default: return nil
            }
        case .iconOnly:
            return nil
        }
    }

    /// Back-compat convenience used by older call sites/tests.
    public func text(summary: Summary?, worstPercent: Double?) -> String? {
        text(Inputs(summary: summary, worstPercent: worstPercent))
    }

    public var label: String {
        switch self {
        case .sessionStatus: return "Session status"
        case .todayTokens: return "Today's tokens"
        case .limitPercent: return "Highest usage %"
        case .todayCost: return "Today's cost"
        case .tokensPlusLimit: return "Tokens + limit"
        case .iconOnly: return "Icon only"
        }
    }
}

/// Rising-edge alert detection for the Claude windows (mirror of the sidecar's
/// tested detectAlerts; the sidecar handles Codex, Swift handles Claude).
public struct AlertEdge: Sendable {
    public static let thresholds: [Double] = [80, 95]
    private var previous: Double?

    public init() {}

    public mutating func feed(_ percent: Double?) -> [(kind: String, level: Int?, percent: Double)] {
        guard let percent, percent.isFinite else { return [] }
        defer { previous = percent }
        guard let prev = previous else { return [] } // first sample: no edge
        if prev - percent >= 30 || (prev >= Self.thresholds[0] && percent < Self.thresholds[0]) {
            return [("reset", nil, percent)]
        }
        return Self.thresholds.compactMap { level in
            prev < level && percent >= level ? ("threshold", Int(level), percent) : nil
        }
    }
}
