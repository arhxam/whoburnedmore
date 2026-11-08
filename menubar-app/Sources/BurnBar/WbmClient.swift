import BurnBarCore
import Foundation

/// Leaderboard data for the always-present island section.
/// No stored sign-in gets a connect prompt. A stored sign-in with sync off
/// stays signed in. Network failure gets an offline state.
enum WbmState: Equatable {
    case noAccount
    /// A handle or token is already stored, and leaderboard sync is off.
    /// `handle` is empty only when a token is stored without a handle.
    case signedInSyncOff(handle: String)
    case offline(handle: String)
    case ready(WbmProfile)
}

@MainActor
final class WbmClient {
    static func apiBase() -> String? {
        TrustedWebURL.apiOrigin(environment: ProcessInfo.processInfo.environment)
    }

    static func signedInTitle(_ handle: String) -> String {
        handle.isEmpty ? "Signed in" : "Signed in as @\(handle)"
    }

    static func hasCliToken() -> Bool {
        storedAccount().hasToken
    }

    /// Sync off is not the same as signed out. Fetching stays disabled either way.
    static func accountStateForDisabledSync() -> WbmState {
        let account = storedAccount()
        if account.hasToken || account.handle != nil {
            return .signedInSyncOff(handle: account.handle ?? "")
        }
        return .noAccount
    }

    static func configuredHandle() -> String? {
        storedAccount().handle
    }

    private struct StoredAccount {
        var handle: String?
        var hasToken: Bool
    }

    /// First config that already has a handle or token. `WHOBURNEDMORE_CONFIG_DIR`
    /// is checked before `~/.config/whoburnedmore`.
    private static func storedAccount() -> StoredAccount {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            ProcessInfo.processInfo.environment["WHOBURNEDMORE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) },
            home.appendingPathComponent(".config/whoburnedmore"),
        ].compactMap { $0 }
        for dir in candidates {
            let file = dir.appendingPathComponent("config.json")
            guard let data = try? Data(contentsOf: file),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let handle = (object["handle"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let token = object["cliToken"] as? String
            let hasToken = !(token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            if handle != nil || hasToken {
                return StoredAccount(handle: handle, hasToken: hasToken)
            }
        }
        return StoredAccount(handle: nil, hasToken: false)
    }

    func fetch() async -> WbmState {
        guard let handle = Self.configuredHandle() else { return .noAccount }
        guard let api = Self.apiBase(),
              let profileURL = URL(string: "\(api)/v1/users/\(handle)"),
              let leaderboardURL = URL(string: "\(api)/v1/leaderboard?period=today&by=tokens") else {
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
        req.setValue("burnbar/0.8.3", forHTTPHeaderField: "User-Agent")
        do {
            let (data, http) = try await BoundedHTTP.data(for: req, maxBytes: 2 * 1024 * 1024)
            guard http.statusCode == 200 else { return nil }
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
