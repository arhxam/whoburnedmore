import BurnBarCore
import Foundation
import os

/// Claude limits: Keychain "Claude Code-credentials" → GET api.anthropic.com/api/oauth/usage.
///
/// Token handling rules (see spec):
///  - The token lives in memory for the duration of one request only.
///  - We NEVER refresh the CLI-owned OAuth token (rotation would break `claude` login).
///    Expired token → `.stale`, and we re-read the Keychain on the next poll.
///  - Keychain is read by spawning /usr/bin/security, which is typically already in
///    the item's ACL (no per-app prompt storm — the CodexBar failure mode). Fallback
///    is a direct SecItem read, which may show ONE system prompt ("Always Allow").
///  - On 429 we honor Retry-After (default 5 min) before polling again.
enum ClaudeUsageState: Equatable {
    case unavailable(reason: String) // no keychain item / no token
    case stale(reason: String) // expired token, auth error
    case ready(ClaudeUsage)
}

@MainActor
final class ClaudeUsageClient {
    private let log = Logger(subsystem: "com.whoburnedmore.burnbar", category: "claude")
    private var cooldownUntil: Date = .distantPast

    func fetch() async -> ClaudeUsageState? {
        guard Date() >= cooldownUntil else { return nil } // still rate-limit-gated
        // Read the Keychain OFF the main actor: spawning /usr/bin/security and
        // waitUntilExit() block, and a Keychain "Always Allow" prompt would
        // otherwise freeze the entire menu-bar UI on every 60s poll.
        guard let token = await Task.detached(priority: .utility, operation: { Self.readTokenSync() }).value else {
            return .unavailable(reason: "Claude Code sign-in not found")
        }
        if let expiresAt = token.expiresAt, expiresAt < Date() {
            return .stale(reason: "Claude session expired — run claude to refresh")
        }

        var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        req.httpMethod = "GET"
        req.timeoutInterval = 30
        req.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("claude-code/2.1.0", forHTTPHeaderField: "User-Agent")

        do {
            let (data, http) = try await BoundedHTTP.data(for: req, maxBytes: 512 * 1024)
            switch http.statusCode {
            case 200:
                guard let usage = ClaudeUsage.decode(from: data) else {
                    return .stale(reason: "unrecognized usage payload")
                }
                return .ready(usage)
            case 401:
                return .stale(reason: "Claude session expired — run claude to refresh")
            case 429:
                let retryAfter = (http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)) ?? 300
                cooldownUntil = Date().addingTimeInterval(retryAfter)
                log.warning("usage endpoint 429 — cooling down \(Int(retryAfter))s")
                return nil // keep last known state
            default:
                return .stale(reason: "usage endpoint HTTP \(http.statusCode)")
            }
        } catch {
            return .stale(reason: "offline: \(error.localizedDescription)")
        }
    }

    // MARK: Keychain

    private struct Token: Sendable {
        let accessToken: String
        let expiresAt: Date?
    }

    /// Blocking Keychain read + parse. `nonisolated static` so it runs on a
    /// detached (non-main) executor — see `fetch()`.
    private nonisolated static func readTokenSync() -> Token? {
        if let raw = readViaSecurityCLI() ?? readViaSecItem() {
            return parseCredentials(raw)
        }
        return nil
    }

    private nonisolated static func parseCredentials(_ raw: Data) -> Token? {
        struct Creds: Decodable {
            struct OAuth: Decodable {
                let accessToken: String?
                let expiresAt: Double?
            }
            let claudeAiOauth: OAuth?
        }
        // Gotcha (CodexBar issue #1844): the item can hold only mcpOAuth — treat as unauthenticated.
        guard let creds = try? JSONDecoder().decode(Creds.self, from: raw),
              let access = creds.claudeAiOauth?.accessToken, !access.isEmpty else { return nil }
        let expires = creds.claudeAiOauth?.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) }
        return Token(accessToken: access, expiresAt: expires)
    }

    private nonisolated static func readViaSecurityCLI() -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        p.arguments = ["find-generic-password", "-w", "-s", "Claude Code-credentials"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0, !data.isEmpty else { return nil }
        let trimmed = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.data(using: .utf8)
    }

    private nonisolated static func readViaSecItem() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }
}
