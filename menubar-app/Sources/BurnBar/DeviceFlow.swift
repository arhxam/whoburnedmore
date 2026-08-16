import AppKit
import BurnBarCore
import Foundation
import os

/// In-app whoburnedmore connect via the CLI's device flow. Writes the SAME
/// ~/.config/whoburnedmore/config.json the CLI uses (read-modify-write, 0600),
/// so app and CLI stay interchangeable.
@MainActor
final class DeviceFlow: ObservableObject {
    enum State: Equatable {
        case idle
        case waiting(userCode: String)
        case connected(handle: String)
        case failed(String)
    }

    @Published var state: State = .idle
    private let log = Logger(subsystem: "com.whoburnedmore.burnbar", category: "deviceflow")
    private var pollTask: Task<Void, Never>?

    static func configFileURL() -> URL {
        if let dir = ProcessInfo.processInfo.environment["WHOBURNEDMORE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir).appendingPathComponent("config.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/whoburnedmore/config.json")
    }

    func start() {
        pollTask?.cancel()
        pollTask = Task { await run() }
    }

    func cancel() {
        pollTask?.cancel()
        state = .idle
    }

    private func run() async {
        do {
            guard let api = WbmClient.apiBase() else {
                throw NSError(domain: "burnbar", code: 2, userInfo: [NSLocalizedDescriptionKey: "invalid API origin"])
            }
            let start: StartResp = try await post(url: "\(api)/v1/auth/device", body: [:])
            state = .waiting(userCode: start.userCode)
            let webBase = ProcessInfo.processInfo.environment["WHOBURNEDMORE_WEB"]
                ?? "https://whoburnedmore.com"
            if let allowedBase = URL(string: webBase),
               let url = TrustedWebURL.deviceVerification(
                   start.verifyUrl,
                   allowedBase: allowedBase
               ) {
                NSWorkspace.shared.open(url)
            } else {
                // Keep the user code visible for manual entry, but never dispatch
                // a server-controlled file/custom/wrong-origin URL through macOS.
                log.warning("refused untrusted device verification URL")
            }

            let deadline = Date().addingTimeInterval(TimeInterval(start.expiresInSeconds ?? 600))
            let interval = TimeInterval(start.pollIntervalSeconds ?? 3)
            while Date() < deadline, !Task.isCancelled {
                try await Task.sleep(for: .seconds(interval))
                let poll: TokenResp = try await post(
                    url: "\(api)/v1/auth/device/token",
                    body: ["deviceCode": start.deviceCode]
                )
                switch poll.status {
                case "ok":
                    guard let token = poll.token,
                          let refreshToken = poll.refreshToken,
                          let handle = poll.handle else {
                        state = .failed("malformed token response")
                        return
                    }
                    let anonKey = try AuthConfigStore.persist(
                        url: Self.configFileURL(),
                        token: token,
                        refreshToken: refreshToken,
                        handle: handle
                    )
                    await bindDevice(api: api, token: token, anonKey: anonKey)
                    state = .connected(handle: handle)
                    return
                case "expired":
                    state = .failed("code expired — try again")
                    return
                default:
                    continue // pending
                }
            }
            if case .waiting = state { state = .failed("timed out — try again") }
        } catch {
            if !Task.isCancelled { state = .failed(error.localizedDescription) }
        }
    }

    private func bindDevice(api: String, token: String, anonKey: String) async {
        guard let url = URL(string: "\(api)/v1/me/devices/bind") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["anonKey": anonKey])
        _ = try? await BoundedHTTP.data(for: req, maxBytes: 512 * 1024) // best-effort; refresh still works via CLI
    }

    private struct StartResp: Decodable {
        let deviceCode: String
        let userCode: String
        let verifyUrl: String
        let expiresInSeconds: Int?
        let pollIntervalSeconds: Int?
    }
    private struct TokenResp: Decodable {
        let status: String
        let token: String?
        let refreshToken: String?
        let handle: String?
    }

    private func post<T: Decodable>(url: String, body: [String: String]) async throws -> T {
        guard let u = URL(string: url) else {
            throw NSError(domain: "burnbar", code: 2, userInfo: [NSLocalizedDescriptionKey: "invalid API URL"])
        }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("burnbar/0.8.1", forHTTPHeaderField: "User-Agent")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await BoundedHTTP.data(for: req, maxBytes: 512 * 1024)
        guard (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "burnbar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "device flow HTTP \(http.statusCode)",
            ])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
