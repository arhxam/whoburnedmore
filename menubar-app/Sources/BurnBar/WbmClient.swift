import BurnBarCore
import Foundation

/// The optional whoburnedmore strip. Standalone-first: no config file → hidden;
/// network failure → `.offline` (burn zones are never affected).
enum WbmState: Equatable {
    case noAccount
    case offline(handle: String)
    case ready(WbmProfile)
}

@MainActor
final class WbmClient {
    static func apiBase() -> String {
        ProcessInfo.processInfo.environment["BURNBAR_API_BASE"] ?? "https://api.whoburnedmore.com"
    }

    static func configuredHandle() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            ProcessInfo.processInfo.environment["WHOBURNEDMORE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) },
            home.appendingPathComponent(".config/whoburnedmore"),
        ].compactMap { $0 }
        for dir in candidates {
            let file = dir.appendingPathComponent("config.json")
            guard let data = try? Data(contentsOf: file) else { continue }
            struct Cfg: Decodable { let handle: String? }
            if let handle = (try? JSONDecoder().decode(Cfg.self, from: data))?.handle, !handle.isEmpty {
                return handle
            }
        }
        return nil
    }

    func fetch() async -> WbmState {
        guard let handle = Self.configuredHandle() else { return .noAccount }
        guard let profileURL = URL(string: "\(Self.apiBase())/v1/users/\(handle)"),
              let leaderboardURL = URL(string: "\(Self.apiBase())/v1/leaderboard?period=all&by=tokens") else {
            return .offline(handle: handle)
        }

        async let profileData = fetchData(from: profileURL)
        async let leaderboardData = fetchData(from: leaderboardURL)

        guard let data = await profileData,
              let profile = WbmProfile.decode(handle: handle, data: data) else {
            return .offline(handle: handle)
        }
        guard let boardData = await leaderboardData,
              let board = WbmLeaderboard.decode(data: boardData) else {
            // Profile/rank availability remains useful even if the public board
            // is temporarily stale or unreachable.
            return .ready(profile)
        }
        return .ready(
            profile.withLeaderboardContext(
                board.context(for: handle),
                dailyLeader: board.dailyLeader
            )
        )
    }

    private func fetchData(from url: URL) async -> Data? {
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        req.setValue("burnbar/0.6.0", forHTTPHeaderField: "User-Agent")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch {
            return nil
        }
    }

    static func profileURL() -> URL? {
        guard let handle = configuredHandle() else { return nil }
        let web = ProcessInfo.processInfo.environment["WHOBURNEDMORE_WEB"] ?? "https://whoburnedmore.com"
        return URL(string: "\(web)/u/\(handle)")
    }
}
