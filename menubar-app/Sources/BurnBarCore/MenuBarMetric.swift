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
    case creditsRemaining // provider-reported prepaid credits (Codex only)
    case none

    /// One provider's numbers, so a menu-bar slot can be scoped to Claude, Codex,
    /// Cursor, … instead of the aggregate. Any field may be nil (the slot then
    /// collapses). Token/cost come from that tool's daily breakdown; the window
    /// percents/resets come from its live limits.
    public struct ProviderStats: Sendable {
        public var sessionPercent: Double?
        public var sessionReset: Date?
        public var weeklyPercent: Double?
        public var weeklyReset: Date?
        public var todayTokens: Int?
        public var todayCost: Double?
        public var sessionTokens: Int?
        public var creditsRemaining: String?

        public init(
            sessionPercent: Double? = nil, sessionReset: Date? = nil,
            weeklyPercent: Double? = nil, weeklyReset: Date? = nil,
            todayTokens: Int? = nil, todayCost: Double? = nil, sessionTokens: Int? = nil,
            creditsRemaining: String? = nil
        ) {
            self.sessionPercent = sessionPercent
            self.sessionReset = sessionReset
            self.weeklyPercent = weeklyPercent
            self.weeklyReset = weeklyReset
            self.todayTokens = todayTokens
            self.todayCost = todayCost
            self.sessionTokens = sessionTokens
            self.creditsRemaining = creditsRemaining
        }
    }

    public struct Inputs {
        public let summary: Summary?
        public let worstPercent: Double?
        public let sessionPercent: Double?
        public let sessionReset: Date?
        public let sessionTokens: Int?
        public let weeklyPercent: Double?
        public let weeklyReset: Date?
        public let now: Date
        /// Per-provider numbers, keyed "claude"|"codex"|"cursor"|… . The default
        /// slot ("all") uses the flat fields above; a provider-scoped slot reads
        /// from here.
        public let byProvider: [String: ProviderStats]

        public init(
            summary: Summary?, worstPercent: Double?, sessionPercent: Double?,
            sessionReset: Date?, sessionTokens: Int?, weeklyPercent: Double?,
            weeklyReset: Date? = nil,
            byProvider: [String: ProviderStats] = [:],
            now: Date = Date()
        ) {
            self.summary = summary
            self.worstPercent = worstPercent
            self.sessionPercent = sessionPercent
            self.sessionReset = sessionReset
            self.sessionTokens = sessionTokens
            self.weeklyPercent = weeklyPercent
            self.weeklyReset = weeklyReset
            self.byProvider = byProvider
            self.now = now
        }
    }

    /// Metrics whose value depends on WHICH provider — these get a provider tag
    /// in the bar when scoped to a specific one. (Tightest/none are global.)
    public var isProviderScoped: Bool {
        switch self {
        case .tightestLimit, .none: return false
        default: return true
        }
    }

    public func text(_ i: Inputs) -> String? {
        switch self {
        case .sessionPercent: return Formatters.percent(i.sessionPercent)
        case .sessionCountdown:
            guard let r = i.sessionReset else { return nil }
            return Formatters.countdown(to: r, from: i.now)
        case .sessionTokens: return i.sessionTokens.map { Formatters.compactTokens($0) }
        case .todayTokens: return i.summary.map { Formatters.compactTokens($0.today.totalTokens) }
        case .todayCost: return i.summary.map { Formatters.usd($0.today.costUSD) }
        case .weeklyPercent: return Formatters.percent(i.weeklyPercent)
        case .weeklyReset:
            guard let r = i.weeklyReset else { return nil }
            return Formatters.countdown(to: r, from: i.now)
        case .weekTokens: return i.summary.map { Formatters.compactTokens($0.week.totalTokens) }
        case .weekCost: return i.summary.map { Formatters.usd($0.week.costUSD) }
        case .tightestLimit: return Formatters.percent(i.worstPercent)
        case .creditsRemaining: return nil
        case .none: return nil
        }
    }

    /// Provider-scoped value. `provider == "all"` (or a metric that isn't
    /// provider-scoped) uses the aggregate `text(i)`. A slot scoped to a specific
    /// provider that has NO stats collapses to nil — it must never show the
    /// aggregate number tagged with that provider's letter (e.g. "U 53%" implying
    /// Cursor is at 53% when 53% is really Claude's aggregate).
    public func text(_ i: Inputs, provider: String) -> String? {
        guard provider != "all", isProviderScoped else { return text(i) }
        guard let s = i.byProvider[provider] else { return nil }
        switch self {
        case .sessionPercent: return Formatters.percent(s.sessionPercent)
        case .sessionCountdown: return s.sessionReset.map { Formatters.countdown(to: $0, from: i.now) }
        case .sessionTokens: return s.sessionTokens.map { Formatters.compactTokens($0) }
        case .todayTokens: return s.todayTokens.map { Formatters.compactTokens($0) }
        case .todayCost: return s.todayCost.map { Formatters.usd($0) }
        case .weeklyPercent: return Formatters.percent(s.weeklyPercent)
        case .weeklyReset: return s.weeklyReset.map { Formatters.countdown(to: $0, from: i.now) }
        // Per-provider week totals aren't tracked; collapse rather than mislead.
        case .weekTokens, .weekCost: return nil
        case .creditsRemaining: return s.creditsRemaining.map { "\($0) cr" }
        case .tightestLimit, .none: return text(i)
        }
    }

    /// Readable provider tag shown in the bar for provider-scoped slots.
    public static func providerTag(_ provider: String) -> String {
        switch provider {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "cursor": return "Cursor"
        case "copilot": return "Copilot"
        case "gemini": return "Gemini"
        default: return provider.isEmpty ? "" : provider.capitalized
        }
    }

    /// Only offer metrics for which the selected source has honest data.
    public static func availableMetrics(for provider: String, allowNone: Bool) -> [MenuBarMetric] {
        let metrics: [MenuBarMetric]
        switch provider {
        case "all":
            metrics = [.todayTokens, .todayCost, .weekTokens, .weekCost, .tightestLimit]
        case "claude":
            metrics = [.sessionPercent, .sessionCountdown, .weeklyPercent, .weeklyReset, .todayTokens, .todayCost]
        case "codex":
            metrics = [.sessionPercent, .sessionCountdown, .weeklyPercent, .weeklyReset, .creditsRemaining, .todayTokens, .todayCost]
        case "cursor":
            metrics = [.sessionPercent, .sessionCountdown, .todayTokens, .todayCost]
        default:
            metrics = [.todayTokens, .todayCost]
        }
        return allowNone ? metrics + [.none] : metrics
    }

    public static func normalized(_ metric: MenuBarMetric, for provider: String, allowNone: Bool) -> MenuBarMetric {
        let available = availableMetrics(for: provider, allowNone: allowNone)
        if available.contains(metric) { return metric }
        return provider == "all" ? .todayTokens : (provider == "claude" || provider == "codex" || provider == "cursor" ? .sessionPercent : .todayTokens)
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
        case .creditsRemaining: return "Credits remaining"
        case .none: return "Nothing"
        }
    }

    public func label(for provider: String) -> String {
        switch self {
        case .sessionPercent: return provider == "cursor" ? "Plan used" : "5-hour used"
        case .sessionCountdown: return provider == "cursor" ? "Plan reset" : "5-hour reset"
        case .weeklyPercent: return "Weekly used"
        default: return label
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

    /// Render provider-scoped slots: each slot is (metric, providerKey). A
    /// provider-specific slot is prefixed with its readable name ("Codex 71%") so a
    /// bar mixing e.g. Claude and Codex session % stays readable; "all" slots and
    /// global metrics render bare.
    public static func slotsText(_ slots: [(MenuBarMetric, String)], _ i: Inputs) -> String? {
        let parts = slots.compactMap { (metric, provider) -> String? in
            guard let v = metric.text(i, provider: provider) else { return nil }
            guard provider != "all", metric.isProviderScoped else { return v }
            let tag = providerTag(provider)
            return tag.isEmpty ? v : "\(tag) \(v)"
        }
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
