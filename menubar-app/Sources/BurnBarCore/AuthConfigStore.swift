import Darwin
import Foundation

public enum AuthConfigStore {
    private static let maximumExistingBytes = 1_048_576

    /// Merge credentials into the shared CLI config and replace it atomically.
    /// The secret is always staged and installed as 0600 inside a 0700 directory.
    @discardableResult
    public static func persist(
        url: URL,
        token: String,
        refreshToken: String,
        handle: String
    ) throws -> String {
        let fm = FileManager.default
        let directory = url.deletingLastPathComponent()
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        var object: [String: Any] = [:]
        if fm.fileExists(atPath: url.path) {
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey])
            guard values.isSymbolicLink != true else {
                throw CocoaError(.fileWriteNoPermission)
            }
            guard (values.fileSize ?? 0) <= maximumExistingBytes else {
                throw CocoaError(.fileReadTooLarge)
            }
            object = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url)))
                as? [String: Any] ?? [:]
        }

        object["cliToken"] = token
        object["refreshToken"] = refreshToken
        object["handle"] = handle
        let anonKey: String
        if let existing = object["anonKey"] as? String, !existing.isEmpty {
            anonKey = existing
        } else {
            anonKey = (0..<32).map { _ in
                String(format: "%02x", UInt8.random(in: 0...255))
            }.joined()
            object["anonKey"] = anonKey
        }

        let data = try JSONSerialization.data(
            withJSONObject: object,
            options: [.prettyPrinted, .sortedKeys]
        )
        let temporary = directory.appendingPathComponent(
            ".config.json.burnbar-\(UUID().uuidString).tmp"
        )
        guard fm.createFile(
            atPath: temporary.path,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { try? fm.removeItem(at: temporary) }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)

        let renameResult = temporary.path.withCString { source in
            url.path.withCString { destination in Darwin.rename(source, destination) }
        }
        guard renameResult == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        // Defense in depth for unusual filesystems that do not preserve the
        // staged inode's mode exactly across replacement.
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return anonKey
    }
}
