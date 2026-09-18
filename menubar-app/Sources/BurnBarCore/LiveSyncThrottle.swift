import Foundation

/// Coalesces a continuous stream of local token totals into near-live
/// leaderboard uploads. The first non-zero total is eligible immediately;
/// while tokens keep arriving, the newest total is eligible once per fixed
/// interval. This is deliberately a throttle, not a debounce: a long-running
/// agent response can never postpone website updates until the response ends.
public struct LiveSyncThrottle {
    public let minimumInterval: TimeInterval

    private var pendingTokens: Int = 0
    private var lastAttemptAt: Date?
    private var lastSyncedTokens: Int?

    public init(minimumInterval: TimeInterval) {
        self.minimumInterval = max(0, minimumInterval)
    }

    public mutating func observe(tokens: Int) {
        pendingTokens = max(0, tokens)
    }

    /// Returns the newest total when an upload should begin and records the
    /// attempt time. Call `markSynced` after a successful upload; failures stay
    /// pending and are retried after the same bounded interval.
    public mutating func beginIfDue(now: Date = Date()) -> Int? {
        guard nextAttemptDelay(now: now) == 0 else { return nil }
        lastAttemptAt = now
        return pendingTokens
    }

    /// No timer is needed after unchanged usage has been synced. A pending
    /// change or failed upload gets one deadline, rather than a perpetual poll.
    public func nextAttemptDelay(now: Date = Date()) -> TimeInterval? {
        guard pendingTokens > 0, pendingTokens != lastSyncedTokens else { return nil }
        guard let lastAttemptAt else { return 0 }
        return max(0, minimumInterval - now.timeIntervalSince(lastAttemptAt))
    }

    public mutating func markSynced(tokens: Int) {
        guard tokens > 0 else { return }
        lastSyncedTokens = tokens
    }
}
