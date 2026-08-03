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
            let api = WbmClient.apiBase()
            let start: StartResp = try await post(url: "\(api)/v1/auth/device", body: [:])
            state = .waiting(userCode: start.userCode)
            if let url = URL(string: start.verifyUrl) { NSWorkspace.shared.open(url) }

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
                    guard let token = poll.token, let handle = poll.handle else {
                        state = .failed("malformed token response")
                        return
                    }
                    let anonKey = try persist(token: token, handle: handle)
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

    /// Merge into the CLI's config.json without clobbering unknown fields.
    private func persist(token: String, handle: String) throws -> String {
        let url = Self.configFileURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        var obj = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
        obj["cliToken"] = token
        obj["handle"] = handle
        let anonKey: String
        if let existing = obj["anonKey"] as? String, !existing.isEmpty {
            anonKey = existing
        } else {
            anonKey = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
            obj["anonKey"] = anonKey
        }
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".config.json.burnbar-tmp")
        try data.write(to: tmp)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        return anonKey
    }

    private func bindDevice(api: String, token: String, anonKey: String) async {
        var req = URLRequest(url: URL(string: "\(api)/v1/me/devices/bind")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["anonKey": anonKey])
        _ = try? await URLSession.shared.data(for: req) // best-effort; refresh still works via CLI
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
        let handle: String?
    }

    private func post<T: Decodable>(url: String, body: [String: String]) async throws -> T {
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("burnbar/0.2.0", forHTTPHeaderField: "User-Agent")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "burnbar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "device flow HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)",
            ])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
