import Foundation

public enum BackgroundActivityPolicy {
    /// Live leaderboard upload polling is opt-in; an off toggle must mean no
    /// periodic wakeups as well as no network traffic.
    public static func syncPollInterval(syncEnabled: Bool) -> TimeInterval? {
        syncEnabled ? 5 : nil
    }
}

public enum PublishedValuePolicy {
    public static func shouldPublish<Value: Equatable>(
        current: Value?, incoming: Value
    ) -> Bool {
        current != incoming
    }
}
