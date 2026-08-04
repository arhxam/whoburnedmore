import Foundation

/// One metric row for a provider (a window/limit). The FIRST metric of a
/// provider is its "headline" — the number shown in the ring. The rest are the
/// per-provider detail points shown underneath, and they differ per provider
/// (Claude has 5h + weekly + per-model; Codex has 5h + weekly + credits; etc.).
public struct ProviderMetric: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let percent: Double?
    public let reset: Date?
    public let forecast: Date?
    /// Non-percent detail (e.g. Codex credit balance, "no window pressure").
    public let note: String?

    public init(
        id: String, label: String, percent: Double?, reset: Date? = nil,
        forecast: Date? = nil, note: String? = nil
    ) {
        self.id = id
        self.label = label
        self.percent = percent
        self.reset = reset
        self.forecast = forecast
        self.note = note
    }
}

/// A provider's full limit picture: a headline + detail metrics + brand.
public struct ProviderLimit: Identifiable, Equatable, Sendable {
    public let id: String // "claude" | "codex" | "cursor" | "copilot" | "gemini"
    public let name: String
    public let metrics: [ProviderMetric]

    public init(id: String, name: String, metrics: [ProviderMetric]) {
        self.id = id
        self.name = name
        self.metrics = metrics
    }

    public var headline: ProviderMetric? { metrics.first }
    public var detail: [ProviderMetric] { metrics.count > 1 ? Array(metrics.dropFirst()) : [] }
    public var headlinePercent: Double? { headline?.percent }
    public var hasData: Bool { !metrics.isEmpty }
}

/// How the popover's optional hero is chosen (Settings → Menu bar).
public enum PrimaryChoice: Equatable, Sendable {
    case none // rings only, no hero
    case tightest // auto: whichever window is closest to its cap
    case provider(String) // pin a specific provider as the hero

    public var rawValue: String {
        switch self {
        case .none: return "none"
        case .tightest: return "tightest"
        case .provider(let id): return "provider:\(id)"
        }
    }
    public init(rawValue: String) {
        if rawValue == "none" { self = .none }
        else if rawValue == "tightest" { self = .tightest }
        else if rawValue.hasPrefix("provider:") { self = .provider(String(rawValue.dropFirst(9))) }
        else { self = .tightest }
    }
}

public enum ProviderLimits {
    /// Resolve the hero provider for a given choice (nil = show no hero).
    public static func hero(from limits: [ProviderLimit], choice: PrimaryChoice) -> ProviderLimit? {
        switch choice {
        case .none:
            return nil
        case .tightest:
            return limits
                .filter { $0.headlinePercent != nil }
                .max { ($0.headlinePercent ?? 0) < ($1.headlinePercent ?? 0) }
        case .provider(let id):
            return limits.first { $0.id == id && $0.hasData }
                ?? hero(from: limits, choice: .tightest) // pinned provider offline → fall back
        }
    }

    /// The full demo stack (BURNBAR_DEMO_LIMITS=1) — used only to preview the
    /// multi-provider look on a machine that isn't signed into every tool.
    public static func demo(now: Date = Date()) -> [ProviderLimit] {
        func at(_ h: Double) -> Date { now.addingTimeInterval(h * 3600) }
        return [
            ProviderLimit(id: "claude", name: "Claude", metrics: [
                ProviderMetric(id: "c5", label: "5h window", percent: 53, reset: at(3.47), forecast: at(4.0)),
                ProviderMetric(id: "cw", label: "weekly", percent: 45, reset: at(134)),
                ProviderMetric(id: "cf", label: "Fable weekly", percent: 84, reset: at(134), forecast: at(50)),
            ]),
            ProviderLimit(id: "codex", name: "Codex", metrics: [
                ProviderMetric(id: "x5", label: "5h window", percent: 71, reset: at(2.08), forecast: at(2.6)),
                ProviderMetric(id: "xw", label: "weekly", percent: 31, reset: at(150)),
                ProviderMetric(id: "xc", label: "credits", percent: nil, note: "$12.50 left"),
            ]),
            ProviderLimit(id: "cursor", name: "Cursor", metrics: [
                ProviderMetric(id: "u", label: "plan usage", percent: 61, reset: at(240)),
            ]),
            ProviderLimit(id: "copilot", name: "Copilot", metrics: [
                ProviderMetric(id: "p", label: "monthly", percent: 34, reset: at(600)),
            ]),
            ProviderLimit(id: "gemini", name: "Gemini", metrics: [
                ProviderMetric(id: "g", label: "daily", percent: 88, reset: at(6.67), forecast: at(2.5)),
            ]),
        ]
    }
}
