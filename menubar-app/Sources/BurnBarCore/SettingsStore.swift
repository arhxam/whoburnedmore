import Foundation
import Combine

/// All user preferences, UserDefaults-backed. Every popover section, provider
/// row, notification switch and display mode routes through here so the
/// Settings window is the single source of truth for UI customization.
@MainActor
public final class SettingsStore: ObservableObject {
    private let d: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        d = defaults
        if ProcessInfo.processInfo.environment["BURNBAR_RESET_DEFAULTS"] == "1" {
            for key in Keys.all { defaults.removeObject(forKey: key) }
        }
        textMode = MenuBarTextMode(rawValue: d.string(forKey: Keys.textMode) ?? "") ?? .sessionStatus
        // v0.3 metric slots: explicit values win; else migrate from legacy textMode.
        let migrated = MenuBarMetric.migrate(
            from: MenuBarTextMode(rawValue: d.string(forKey: Keys.textMode) ?? "") ?? .sessionStatus
        )
        metricSlot1 = MenuBarMetric(rawValue: d.string(forKey: Keys.metricSlot1) ?? "") ?? migrated.0
        metricSlot2 = MenuBarMetric(rawValue: d.string(forKey: Keys.metricSlot2) ?? "") ?? migrated.1
        metricSlot3 = MenuBarMetric(rawValue: d.string(forKey: Keys.metricSlot3) ?? "") ?? .none
        tintThresholds = Self.bool(d, Keys.tintThresholds, true)
        showLimits = Self.bool(d, Keys.showLimits, true)
        showForecast = Self.bool(d, Keys.showForecast, true)
        showPerModel = Self.bool(d, Keys.showPerModel, true)
        showBurn = Self.bool(d, Keys.showBurn, true)
        showStreak = Self.bool(d, Keys.showStreak, true)
        showTools = Self.bool(d, Keys.showTools, true)
        showSessions = Self.bool(d, Keys.showSessions, true)
        showWbm = Self.bool(d, Keys.showWbm, true)
        showRival = Self.bool(d, Keys.showRival, true)
        showStatusDot = Self.bool(d, Keys.showStatusDot, true)
        // Default: only Claude + Codex are shown; the rest are opt-in so the
        // panel starts focused instead of a wall of empty rings.
        providerClaude = Self.bool(d, Keys.providerClaude, true)
        providerCodex = Self.bool(d, Keys.providerCodex, true)
        providerCursor = Self.bool(d, Keys.providerCursor, false)
        providerVscode = Self.bool(d, Keys.providerVscode, false)
        providerLongtail = Self.bool(d, Keys.providerLongtail, false)
        providerCopilot = Self.bool(d, Keys.providerCopilot, false)
        providerGemini = Self.bool(d, Keys.providerGemini, false)
        // Default: NO hero — just the clean rings row. The big summary ring is
        // opt-in (Settings → Popover → Primary).
        primaryProvider = d.string(forKey: Keys.primaryProvider) ?? "none"
        warnThreshold = Self.double(d, Keys.warnThreshold, 80)
        criticalThreshold = Self.double(d, Keys.criticalThreshold, 95)
        notifyThresholds = Self.bool(d, Keys.notifyThresholds, true)
        notifyReset = Self.bool(d, Keys.notifyReset, true)
        notifyForecast = Self.bool(d, Keys.notifyForecast, true)
        notifyOvertaken = Self.bool(d, Keys.notifyOvertaken, false)
        digestEnabled = Self.bool(d, Keys.digestEnabled, false)
        digestHour = Int(Self.double(d, Keys.digestHour, 21))
        limitsRefreshSeconds = Int(Self.double(d, Keys.limitsRefresh, 60))
        syncEnabled = Self.bool(d, Keys.syncEnabled, false)
        onboardingDone = Self.bool(d, Keys.onboardingDone, false)
    }

    // MARK: published + persisted

    @Published public var textMode: MenuBarTextMode { didSet { d.set(textMode.rawValue, forKey: Keys.textMode) } }
    @Published public var metricSlot1: MenuBarMetric { didSet { d.set(metricSlot1.rawValue, forKey: Keys.metricSlot1) } }
    @Published public var metricSlot2: MenuBarMetric { didSet { d.set(metricSlot2.rawValue, forKey: Keys.metricSlot2) } }
    @Published public var metricSlot3: MenuBarMetric { didSet { d.set(metricSlot3.rawValue, forKey: Keys.metricSlot3) } }
    @Published public var tintThresholds: Bool { didSet { d.set(tintThresholds, forKey: Keys.tintThresholds) } }

    @Published public var showLimits: Bool { didSet { d.set(showLimits, forKey: Keys.showLimits) } }
    @Published public var showForecast: Bool { didSet { d.set(showForecast, forKey: Keys.showForecast) } }
    @Published public var showPerModel: Bool { didSet { d.set(showPerModel, forKey: Keys.showPerModel) } }
    @Published public var showBurn: Bool { didSet { d.set(showBurn, forKey: Keys.showBurn) } }
    @Published public var showStreak: Bool { didSet { d.set(showStreak, forKey: Keys.showStreak) } }
    @Published public var showTools: Bool { didSet { d.set(showTools, forKey: Keys.showTools) } }
    @Published public var showSessions: Bool { didSet { d.set(showSessions, forKey: Keys.showSessions) } }
    @Published public var showWbm: Bool { didSet { d.set(showWbm, forKey: Keys.showWbm) } }
    @Published public var showRival: Bool { didSet { d.set(showRival, forKey: Keys.showRival) } }
    @Published public var showStatusDot: Bool { didSet { d.set(showStatusDot, forKey: Keys.showStatusDot) } }

    @Published public var providerClaude: Bool { didSet { d.set(providerClaude, forKey: Keys.providerClaude) } }
    @Published public var providerCodex: Bool { didSet { d.set(providerCodex, forKey: Keys.providerCodex) } }
    @Published public var providerCursor: Bool { didSet { d.set(providerCursor, forKey: Keys.providerCursor) } }
    @Published public var providerVscode: Bool { didSet { d.set(providerVscode, forKey: Keys.providerVscode) } }
    @Published public var providerLongtail: Bool { didSet { d.set(providerLongtail, forKey: Keys.providerLongtail) } }
    @Published public var providerCopilot: Bool { didSet { d.set(providerCopilot, forKey: Keys.providerCopilot) } }
    @Published public var providerGemini: Bool { didSet { d.set(providerGemini, forKey: Keys.providerGemini) } }
    /// Popover hero: "none" | "tightest" | "provider:<id>".
    @Published public var primaryProvider: String { didSet { d.set(primaryProvider, forKey: Keys.primaryProvider) } }

    @Published public var warnThreshold: Double { didSet { d.set(warnThreshold, forKey: Keys.warnThreshold) } }
    @Published public var criticalThreshold: Double { didSet { d.set(criticalThreshold, forKey: Keys.criticalThreshold) } }
    @Published public var notifyThresholds: Bool { didSet { d.set(notifyThresholds, forKey: Keys.notifyThresholds) } }
    @Published public var notifyReset: Bool { didSet { d.set(notifyReset, forKey: Keys.notifyReset) } }
    @Published public var notifyForecast: Bool { didSet { d.set(notifyForecast, forKey: Keys.notifyForecast) } }
    @Published public var notifyOvertaken: Bool { didSet { d.set(notifyOvertaken, forKey: Keys.notifyOvertaken) } }
    @Published public var digestEnabled: Bool { didSet { d.set(digestEnabled, forKey: Keys.digestEnabled) } }
    @Published public var digestHour: Int { didSet { d.set(Double(digestHour), forKey: Keys.digestHour) } }

    @Published public var limitsRefreshSeconds: Int { didSet { d.set(Double(limitsRefreshSeconds), forKey: Keys.limitsRefresh) } }
    @Published public var syncEnabled: Bool { didSet { d.set(syncEnabled, forKey: Keys.syncEnabled) } }
    @Published public var onboardingDone: Bool { didSet { d.set(onboardingDone, forKey: Keys.onboardingDone) } }

    /// Display filter: is this tool's UI row enabled?
    public func providerEnabled(_ tool: String) -> Bool {
        switch tool {
        case "claude": return providerClaude
        case "codex": return providerCodex
        case "cursor": return providerCursor
        case "cline", "roo", "continue": return providerVscode
        default: return providerLongtail
        }
    }

    public enum Keys {
        public static let textMode = "menubar.textMode"
        public static let metricSlot1 = "menubar.metricSlot1"
        public static let metricSlot2 = "menubar.metricSlot2"
        public static let metricSlot3 = "menubar.metricSlot3"
        public static let tintThresholds = "menubar.tint"
        public static let showLimits = "popover.showLimits"
        public static let showForecast = "popover.showForecast"
        public static let showPerModel = "popover.showPerModel"
        public static let showBurn = "popover.showBurn"
        public static let showStreak = "popover.showStreak"
        public static let showTools = "popover.showTools"
        public static let showSessions = "popover.showSessions"
        public static let showWbm = "popover.showWbm"
        public static let showRival = "popover.showRival"
        public static let showStatusDot = "popover.showStatusDot"
        public static let providerClaude = "provider.claude"
        public static let providerCodex = "provider.codex"
        public static let providerCursor = "provider.cursor"
        public static let providerVscode = "provider.vscode"
        public static let providerLongtail = "provider.longtail"
        public static let providerCopilot = "provider.copilot"
        public static let providerGemini = "provider.gemini"
        public static let primaryProvider = "popover.primaryProvider"
        public static let warnThreshold = "notify.warnThreshold"
        public static let criticalThreshold = "notify.criticalThreshold"
        public static let notifyThresholds = "notify.thresholds"
        public static let notifyReset = "notify.reset"
        public static let notifyForecast = "notify.forecast"
        public static let notifyOvertaken = "notify.overtaken"
        public static let digestEnabled = "notify.digest"
        public static let digestHour = "notify.digestHour"
        public static let limitsRefresh = "refresh.limitsSeconds"
        public static let syncEnabled = "sync.enabled"
        public static let onboardingDone = "onboarding.done"
        public static let all: [String] = [
            textMode, metricSlot1, metricSlot2, metricSlot3, tintThresholds, showLimits, showForecast, showPerModel, showBurn,
            showStreak, showTools, showSessions, showWbm, showRival, showStatusDot,
            providerClaude, providerCodex, providerCursor, providerVscode, providerLongtail, providerCopilot, providerGemini, primaryProvider,
            warnThreshold, criticalThreshold, notifyThresholds, notifyReset, notifyForecast,
            notifyOvertaken, digestEnabled, digestHour, limitsRefresh, syncEnabled, onboardingDone,
        ]
    }

    private static func bool(_ d: UserDefaults, _ key: String, _ def: Bool) -> Bool {
        d.object(forKey: key) == nil ? def : d.bool(forKey: key)
    }
    private static func double(_ d: UserDefaults, _ key: String, _ def: Double) -> Double {
        d.object(forKey: key) == nil ? def : d.double(forKey: key)
    }
}
