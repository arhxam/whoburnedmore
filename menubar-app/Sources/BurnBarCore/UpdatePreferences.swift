import Foundation

public struct UpdatePreferences: Equatable, Sendable {
    public static let recommendedDefaults = UpdatePreferences(
        automaticallyChecksForUpdates: true,
        automaticallyDownloadsUpdates: false,
        checkInterval: 86_400
    )

    public private(set) var automaticallyChecksForUpdates: Bool
    public private(set) var automaticallyDownloadsUpdates: Bool
    public let checkInterval: TimeInterval

    public init(
        automaticallyChecksForUpdates: Bool,
        automaticallyDownloadsUpdates: Bool,
        checkInterval: TimeInterval = 86_400
    ) {
        self.automaticallyChecksForUpdates = automaticallyChecksForUpdates
        self.automaticallyDownloadsUpdates = automaticallyChecksForUpdates
            && automaticallyDownloadsUpdates
        self.checkInterval = checkInterval
    }

    public mutating func setAutomaticallyChecksForUpdates(_ enabled: Bool) {
        automaticallyChecksForUpdates = enabled
        if !enabled {
            automaticallyDownloadsUpdates = false
        }
    }

    public mutating func setAutomaticallyDownloadsUpdates(_ enabled: Bool) {
        automaticallyDownloadsUpdates = automaticallyChecksForUpdates && enabled
    }
}

public struct BundleVersionPresentation: Equatable, Sendable {
    public let marketingVersion: String?
    public let buildVersion: String?

    public init(marketingVersion: String?, buildVersion: String?) {
        self.marketingVersion = Self.nonEmpty(marketingVersion)
        self.buildVersion = Self.nonEmpty(buildVersion)
    }

    public var displayName: String {
        switch (marketingVersion, buildVersion) {
        case let (.some(marketing), .some(build)):
            return "BurnBar \(marketing) (\(build))"
        case let (.some(marketing), nil):
            return "BurnBar \(marketing)"
        default:
            return "BurnBar"
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
