import Foundation

// MARK: - Sidecar protocol models (mirror of sidecar/src/protocol.ts)

public struct DayPoint: Codable, Equatable, Sendable {
    public let date: String
    public let tokens: Int
    public let costUSD: Double
}

public struct ToolBreakdown: Codable, Equatable, Sendable, Identifiable {
    public let tool: String
    public let tokens: Int
    public let costUSD: Double
    public var id: String { tool }
}

public struct ModelBreakdown: Codable, Equatable, Sendable, Identifiable {
    public let model: String
    public let tokens: Int
    public var id: String { model }
}

public struct TotalsLine: Codable, Equatable, Sendable {
    public let totalTokens: Int
    public let costUSD: Double
}

public struct SessionToday: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let tool: String
    public let tokens: Int
    public var id: String { "\(tool)|\(name)" }

    public init(name: String, tool: String, tokens: Int) {
        self.name = name
        self.tool = tool
        self.tokens = tokens
    }
}

public struct Summary: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let today: TotalsLine
    public let week: TotalsLine
    public let days: [DayPoint]
    public let byToolToday: [ToolBreakdown]
    public let byTool14d: [ToolBreakdown]
    public let topModelsToday: [ModelBreakdown]
    public let toolsFound: [String]
    public let partial: Bool
    /// v2: top sessions of the local day (optional — older sidecars omit it).
    public let sessionsToday: [SessionToday]?

    public init(
        generatedAt: String, today: TotalsLine, week: TotalsLine, days: [DayPoint],
        byToolToday: [ToolBreakdown], byTool14d: [ToolBreakdown],
        topModelsToday: [ModelBreakdown], toolsFound: [String], partial: Bool,
        sessionsToday: [SessionToday]? = nil
    ) {
        self.generatedAt = generatedAt
        self.today = today
        self.week = week
        self.days = days
        self.byToolToday = byToolToday
        self.byTool14d = byTool14d
        self.topModelsToday = topModelsToday
        self.toolsFound = toolsFound
        self.partial = partial
        self.sessionsToday = sessionsToday
    }
}

public struct WindowLimit: Codable, Equatable, Sendable {
    public let label: String
    public let usedPercent: Double?
    public let windowMinutes: Double?
    public let resetsAt: String?
    public let forecastHitAt: String?

    public init(label: String, usedPercent: Double?, windowMinutes: Double?, resetsAt: String?, forecastHitAt: String? = nil) {
        self.label = label
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetsAt = resetsAt
        self.forecastHitAt = forecastHitAt
    }
}

public struct CodexLimits: Codable, Equatable, Sendable {
    public let present: Bool
    public let capturedAt: String?
    public let planType: String?
    public let limitId: String?
    public let primary: WindowLimit?
    public let secondary: WindowLimit?
    public let creditsBalance: String?
    public let hasCredits: Bool?
    public let unlimited: Bool?
}

public struct CursorLimits: Codable, Equatable, Sendable {
    public let present: Bool
    public let planPercent: Double?
    public let used: Double?
    public let limit: Double?
    public let renewsAt: String?
}

public struct Limits: Codable, Equatable, Sendable {
    public let codex: CodexLimits
    /// v2 (optional — older sidecars omit it).
    public let cursor: CursorLimits?
}

/// One NDJSON line from the sidecar. Unknown types decode to `.unknown`.
public enum SidecarEvent: Equatable, Sendable {
    case hello(version: String, pid: Int)
    case snapshot(Summary)
    case limits(Limits)
    case alert(kind: String, provider: String, level: Int?, percent: Double)
    case status(collecting: Bool, lastFullCollectAt: String?, error: String?)
    case heartbeat(ts: String)
    case unknown

    public static func parse(line: String) -> SidecarEvent? {
        guard let data = line.trimmingCharacters(in: .whitespaces).data(using: .utf8),
              !data.isEmpty else { return nil }
        struct Probe: Decodable {
            let type: String
            let version: String?
            let pid: Int?
            let summary: Summary?
            let limits: Limits?
            let kind: String?
            let provider: String?
            let level: Int?
            let percent: Double?
            let collecting: Bool?
            let lastFullCollectAt: String?
            let error: String?
            let ts: String?
        }
        guard let p = try? JSONDecoder().decode(Probe.self, from: data) else { return nil }
        switch p.type {
        case "hello": return .hello(version: p.version ?? "?", pid: p.pid ?? 0)
        case "snapshot": return p.summary.map { .snapshot($0) }
        case "limits": return p.limits.map { .limits($0) }
        case "alert":
            guard let kind = p.kind, let provider = p.provider, let percent = p.percent else { return .unknown }
            return .alert(kind: kind, provider: provider, level: p.level, percent: percent)
        case "status": return .status(collecting: p.collecting ?? false, lastFullCollectAt: p.lastFullCollectAt, error: p.error)
        case "heartbeat": return .heartbeat(ts: p.ts ?? "")
        default: return .unknown
        }
    }
}

// MARK: - Claude usage models (Anthropic OAuth usage endpoint)

public struct ClaudeWindow: Codable, Equatable, Sendable {
    public let utilization: Double?
    public let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }

    public init(utilization: Double?, resetsAt: String?) {
        self.utilization = utilization
        self.resetsAt = resetsAt
    }
}

public struct ClaudeScopedLimit: Codable, Equatable, Sendable {
    public let kind: String?
    public let percent: Double?
    public let resetsAt: String?
    public let modelName: String?

    public init(kind: String?, percent: Double?, resetsAt: String?, modelName: String?) {
        self.kind = kind
        self.percent = percent
        self.resetsAt = resetsAt
        self.modelName = modelName
    }
}

public struct ClaudeUsage: Equatable, Sendable {
    public let fiveHour: ClaudeWindow?
    public let sevenDay: ClaudeWindow?
    public let scoped: [ClaudeScopedLimit]
    public let fetchedAt: Date

    public init(fiveHour: ClaudeWindow?, sevenDay: ClaudeWindow?, scoped: [ClaudeScopedLimit], fetchedAt: Date) {
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
        self.scoped = scoped
        self.fetchedAt = fetchedAt
    }

    /// Decode the raw endpoint JSON (tolerant: unknown fields ignored, nulls fine).
    public static func decode(from data: Data, fetchedAt: Date = Date()) -> ClaudeUsage? {
        struct Raw: Decodable {
            struct Win: Decodable {
                let utilization: Double?
                let resets_at: String?
            }
            struct Lim: Decodable {
                struct Scope: Decodable {
                    struct M: Decodable { let display_name: String? }
                    let model: M?
                }
                let kind: String?
                let percent: Double?
                let resets_at: String?
                let scope: Scope?
            }
            let five_hour: Win?
            let seven_day: Win?
            let limits: [Lim]?
        }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return nil }
        let scoped = (raw.limits ?? []).map {
            ClaudeScopedLimit(
                kind: $0.kind,
                percent: $0.percent,
                resetsAt: $0.resets_at,
                modelName: $0.scope?.model?.display_name
            )
        }
        return ClaudeUsage(
            fiveHour: raw.five_hour.map { ClaudeWindow(utilization: $0.utilization, resetsAt: $0.resets_at) },
            sevenDay: raw.seven_day.map { ClaudeWindow(utilization: $0.utilization, resetsAt: $0.resets_at) },
            scoped: scoped,
            fetchedAt: fetchedAt
        )
    }
}

// MARK: - whoburnedmore models

public struct WbmLeaderboardEntry: Decodable, Equatable, Identifiable, Sendable {
    public let rank: Int
    public let handle: String
    public let displayName: String
    public let tokens: Int
    public let todayTokens: Int
    public var id: String { handle.lowercased() }

    public init(rank: Int, handle: String, displayName: String, tokens: Int, todayTokens: Int) {
        self.rank = rank
        self.handle = handle
        self.displayName = displayName
        self.tokens = tokens
        self.todayTokens = todayTokens
    }

    private enum CodingKeys: String, CodingKey {
        case rank, handle, displayName, todayTokens
        case tokens = "totalTokens"
    }
}

public struct WbmLeaderboard: Decodable, Equatable, Sendable {
    public let period: String
    public let rows: [WbmLeaderboardEntry]

    public init(period: String, rows: [WbmLeaderboardEntry]) {
        self.period = period
        self.rows = rows
    }

    public static func decode(data: Data) -> WbmLeaderboard? {
        try? JSONDecoder().decode(WbmLeaderboard.self, from: data)
    }

    public var dailyLeader: WbmLeaderboardEntry? {
        rows
            .filter { $0.todayTokens > 0 }
            .max { lhs, rhs in
                lhs.todayTokens == rhs.todayTokens ? lhs.rank > rhs.rank : lhs.todayTokens < rhs.todayTokens
            }
    }

    /// The all-time leaders plus the connected person's nearest rows. The
    /// separate daily-leader callout becomes the sixth person in the popover.
    public func context(for handle: String, maxRows: Int = 5) -> [WbmLeaderboardEntry] {
        guard maxRows > 0 else { return [] }

        var seen = Set<String>()
        let ranked = rows
            .sorted { lhs, rhs in
                lhs.rank == rhs.rank ? lhs.handle < rhs.handle : lhs.rank < rhs.rank
            }
            .filter { seen.insert($0.handle.lowercased()).inserted }

        var selected: [WbmLeaderboardEntry] = []
        var selectedHandles = Set<String>()
        func add(_ row: WbmLeaderboardEntry) {
            guard selected.count < maxRows,
                  selectedHandles.insert(row.handle.lowercased()).inserted else { return }
            selected.append(row)
        }

        for row in ranked.prefix(min(2, maxRows)) { add(row) }

        let normalizedHandle = handle.lowercased()
        guard let targetIndex = ranked.firstIndex(where: { $0.handle.lowercased() == normalizedHandle }) else {
            return selected.sorted { $0.rank < $1.rank }
        }

        add(ranked[targetIndex])
        var distance = 1
        while selected.count < maxRows && (targetIndex - distance >= 0 || targetIndex + distance < ranked.count) {
            if targetIndex - distance >= 0 { add(ranked[targetIndex - distance]) }
            if targetIndex + distance < ranked.count { add(ranked[targetIndex + distance]) }
            distance += 1
        }

        return selected.sorted { lhs, rhs in
            lhs.rank == rhs.rank ? lhs.handle < rhs.handle : lhs.rank < rhs.rank
        }
    }
}

public struct WbmProfile: Equatable, Sendable {
    public let handle: String
    public let rank: Int?
    public let dailyRank: Int?
    public let weeklyRank: Int?
    public let totalTokens: Int?
    public let leaderboardContext: [WbmLeaderboardEntry]
    public let dailyLeader: WbmLeaderboardEntry?

    public init(
        handle: String,
        rank: Int?,
        dailyRank: Int?,
        weeklyRank: Int?,
        totalTokens: Int?,
        leaderboardContext: [WbmLeaderboardEntry] = [],
        dailyLeader: WbmLeaderboardEntry? = nil
    ) {
        self.handle = handle
        self.rank = rank
        self.dailyRank = dailyRank
        self.weeklyRank = weeklyRank
        self.totalTokens = totalTokens
        self.leaderboardContext = leaderboardContext
        self.dailyLeader = dailyLeader
    }

    public func withLeaderboardContext(
        _ context: [WbmLeaderboardEntry],
        dailyLeader: WbmLeaderboardEntry?
    ) -> WbmProfile {
        WbmProfile(
            handle: handle,
            rank: rank,
            dailyRank: dailyRank,
            weeklyRank: weeklyRank,
            totalTokens: totalTokens,
            leaderboardContext: context,
            dailyLeader: dailyLeader
        )
    }

    public static func decode(handle: String, data: Data) -> WbmProfile? {
        struct Raw: Decodable {
            struct Totals: Decodable { let totalTokens: Int? }
            let rank: Int?
            let dailyRank: Int?
            let weeklyRank: Int?
            let totals: Totals?
        }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return nil }
        return WbmProfile(
            handle: handle,
            rank: raw.rank,
            dailyRank: raw.dailyRank,
            weeklyRank: raw.weeklyRank,
            totalTokens: raw.totals?.totalTokens
        )
    }
}
