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
        guard let url = URL(string: "\(Self.apiBase())/v1/users/\(handle)") else {
            return .offline(handle: handle)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        req.setValue("burnbar/0.1.0", forHTTPHeaderField: "User-Agent")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let profile = WbmProfile.decode(handle: handle, data: data) else {
                return .offline(handle: handle)
            }
            return .ready(profile)
        } catch {
            return .offline(handle: handle)
        }
    }

    static func profileURL() -> URL? {
        guard let handle = configuredHandle() else { return nil }
        let web = ProcessInfo.processInfo.environment["WHOBURNEDMORE_WEB"] ?? "https://whoburnedmore.com"
        return URL(string: "\(web)/u/\(handle)")
    }
}
