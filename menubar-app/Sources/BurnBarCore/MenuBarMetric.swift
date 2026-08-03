import Foundation

/// v0.3: the menu bar is COMPOSABLE — the user picks any metric for each of
/// two slots, rendered side by side ("53% · 147.7M"). Supersedes the fixed
/// MenuBarTextMode list (kept only for defaults migration).
public enum MenuBarMetric: String, CaseIterable, Sendable {
    case sessionPercent // Claude 5h window %
    case sessionCountdown // time until the 5h window resets
    case sessionTokens // tokens burned THIS session window (SessionMeter)
    case todayTokens
    case todayCost
    case weeklyPercent // Claude weekly window %
    case weeklyReset // time until the weekly window resets
    case weekTokens
    case weekCost
    case tightestLimit // worst % across every tracked window
    case none

    public struct Inputs {
        public let summary: Summary?
        public let worstPercent: Double?
        public let sessionPercent: Double?
        public let sessionReset: Date?
        public let sessionTokens: Int?
        public let weeklyPercent: Double?
        public let weeklyReset: Date?
        public let now: Date

        public init(
            summary: Summary?, worstPercent: Double?, sessionPercent: Double?,
            sessionReset: Date?, sessionTokens: Int?, weeklyPercent: Double?,
            weeklyReset: Date? = nil,
            now: Date = Date()
        ) {
            self.summary = summary
            self.worstPercent = worstPercent
            self.sessionPercent = sessionPercent
            self.sessionReset = sessionReset
            self.sessionTokens = sessionTokens
            self.weeklyPercent = weeklyPercent
            self.weeklyReset = weeklyReset
            self.now = now
        }
    }

    public func text(_ i: Inputs) -> String? {
        func pct(_ v: Double?) -> String? { v.map { "\(Int($0.rounded()))%" } }
        switch self {
        case .sessionPercent: return pct(i.sessionPercent)
        case .sessionCountdown:
            guard let r = i.sessionReset else { return nil }
            return Formatters.countdown(to: r, from: i.now)
        case .sessionTokens: return i.sessionTokens.map { Formatters.compactTokens($0) }
        case .todayTokens: return i.summary.map { Formatters.compactTokens($0.today.totalTokens) }
        case .todayCost: return i.summary.map { Formatters.usd($0.today.costUSD) }
        case .weeklyPercent: return pct(i.weeklyPercent)
        case .weeklyReset:
            guard let r = i.weeklyReset else { return nil }
            return Formatters.countdown(to: r, from: i.now)
        case .weekTokens: return i.summary.map { Formatters.compactTokens($0.week.totalTokens) }
        case .weekCost: return i.summary.map { Formatters.usd($0.week.costUSD) }
        case .tightestLimit: return pct(i.worstPercent)
        case .none: return nil
        }
    }

    public var label: String {
        switch self {
        case .sessionPercent: return "Session %"
        case .sessionCountdown: return "Session reset"
        case .sessionTokens: return "Tokens this session"
        case .todayTokens: return "Today's tokens"
        case .todayCost: return "Today's cost"
        case .weeklyPercent: return "Weekly %"
        case .weeklyReset: return "Weekly reset"
        case .weekTokens: return "This week's tokens"
        case .weekCost: return "This week's cost"
        case .tightestLimit: return "Tightest limit %"
        case .none: return "Nothing"
        }
    }

    /// Render a slot pair: nil slots collapse, both nil → nil (icon only).
    public static func pairText(_ slot1: MenuBarMetric, _ slot2: MenuBarMetric, _ i: Inputs) -> String? {
        slotsText([slot1, slot2], i)
    }

    /// Render any ordered slot list: empty/nil slots collapse, all-nil → nil.
    public static func slotsText(_ slots: [MenuBarMetric], _ i: Inputs) -> String? {
        let parts = slots.compactMap { $0.text(i) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Legacy MenuBarTextMode → slot-pair migration (one-time, at load).
    public static func migrate(from legacy: MenuBarTextMode) -> (MenuBarMetric, MenuBarMetric) {
        switch legacy {
        case .sessionStatus: return (.sessionPercent, .sessionCountdown)
        case .todayTokens: return (.todayTokens, .none)
        case .limitPercent: return (.tightestLimit, .none)
        case .todayCost: return (.todayCost, .none)
        case .tokensPlusLimit: return (.todayTokens, .tightestLimit)
        case .iconOnly: return (.none, .none)
        }
    }
}

/// Tokens burned in the CURRENT 5h session window, accumulated from observed
/// today-total deltas. Honest approximation: it counts burn observed while
/// BurnBar runs (documented in README). Pure and testable.
public struct SessionMeter: Sendable {
    public private(set) var sessionTokens = 0
    private var lastToday: Int?
    private var windowResetAt: Date?

    public init() {}

    /// Feed each snapshot. Returns the current session total.
    @discardableResult
    public mutating func feed(todayTokens: Int, windowResetAt reset: Date?, now: Date = Date()) -> Int {
        // Window rolled over (reset moved to a later instant, or reset passed).
        if let known = windowResetAt {
            if let reset, reset > known.addingTimeInterval(60) {
                sessionTokens = 0
            } else if known < now, reset == nil || reset! <= known {
                // Stored reset elapsed with no fresher one — treat as rolled.
                sessionTokens = 0
            }
        }
        if let reset { windowResetAt = reset }

        if let last = lastToday {
            let delta = todayTokens - last
            if delta >= 0 {
                sessionTokens += delta
            } else {
                // Midnight rollover: today's counter restarted; count the new
                // day's observed total so far (burn across the boundary that we
                // never sampled is unknowable — accept the gap).
                sessionTokens += todayTokens
            }
        }
        lastToday = todayTokens
        return sessionTokens
    }
}
