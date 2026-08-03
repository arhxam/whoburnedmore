import Foundation

/// Statuspage.io "status.json" decoding (status.anthropic.com, status.openai.com).
public struct StatusPageState: Equatable, Sendable {
    public let indicator: String // none | minor | major | critical
    public let description: String?

    public init(indicator: String, description: String?) {
        self.indicator = indicator
        self.description = description
    }

    public static func decode(from data: Data) -> StatusPageState? {
        struct Raw: Decodable {
            struct S: Decodable {
                let indicator: String?
                let description: String?
            }
            let status: S?
        }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data),
              let indicator = raw.status?.indicator else { return nil }
        return StatusPageState(indicator: indicator, description: raw.status?.description)
    }

    public var isHealthy: Bool { indicator == "none" }
    /// Traffic-light bucket for the dot: green / yellow / red.
    public var severity: String {
        switch indicator {
        case "none": return "green"
        case "minor": return "yellow"
        default: return "red"
        }
    }
}
