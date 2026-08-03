import Foundation

/// Swift mirror of the sidecar's tested forecast/threshold math, extended with
/// configurable thresholds (the sidecar handles Codex; this handles Claude).
public struct PercentSample: Equatable, Sendable {
    public let at: Date
    public let percent: Double
    public init(at: Date, percent: Double) {
        self.at = at
        self.percent = percent
    }
}

public enum Forecast {
    /// Linear projection of when the window hits 100%. nil when flat/declining
    /// or fewer than 2 samples inside the lookback.
    public static func limitHit(
        samples: [PercentSample],
        now: Date,
        lookback: TimeInterval = 3600
    ) -> Date? {
        let recent = samples
            .filter { now.timeIntervalSince($0.at) <= lookback && $0.percent.isFinite }
            .sorted { $0.at < $1.at }
        guard recent.count >= 2, let first = recent.first, let last = recent.last else { return nil }
        if last.percent >= 100 { return now }
        let dt = last.at.timeIntervalSince(first.at)
        let dp = last.percent - first.percent
        guard dt > 0, dp > 0 else { return nil }
        let rate = dp / dt
        return last.at.addingTimeInterval((100 - last.percent) / rate)
    }
}

/// Rising-edge detection with CONFIGURABLE thresholds and reset awareness.
public struct ConfigurableAlertEdge: Sendable {
    public var thresholds: [Double]
    private var previous: Double?

    public init(thresholds: [Double] = [80, 95]) {
        self.thresholds = thresholds.sorted()
    }

    public mutating func feed(_ percent: Double?) -> [(kind: String, level: Int?, percent: Double)] {
        guard let percent, percent.isFinite else { return [] }
        defer { previous = percent }
        guard let prev = previous else { return [] }
        let lowest = thresholds.first ?? 80
        if prev - percent >= 30 || (prev >= lowest && percent < lowest) {
            return [("reset", nil, percent)]
        }
        return thresholds.compactMap { level in
            prev < level && percent >= level ? ("threshold", Int(level), percent) : nil
        }
    }
}

/// One-shot "shoulder tap": fires when a limit is projected to hit the cap
/// within `leadTime`, at most once per window climb (re-arms on reset/decline).
public struct ForecastAlarm: Sendable {
    public var leadTime: TimeInterval
    private var armed = true

    public init(leadTime: TimeInterval = 30 * 60) {
        self.leadTime = leadTime
    }

    public mutating func feed(forecastHit: Date?, percent: Double?, now: Date) -> Bool {
        if let percent, percent < 50 { armed = true } // window rolled over / calmed down
        guard armed, let hit = forecastHit else { return false }
        let dt = hit.timeIntervalSince(now)
        guard dt > 0, dt <= leadTime else { return false }
        armed = false
        return true
    }
}
