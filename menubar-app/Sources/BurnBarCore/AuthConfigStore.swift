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
        var object = try readMergingObject(at: url)
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
        try writePrivateObject(object, at: url)
        return anonKey
    }

    /// Stamp `deviceBoundAt` after `/v1/me/devices/bind` returns a definitive
    /// answer. The value is epoch milliseconds, matching the CLI's `recordDeviceBound`.
    public static func recordDeviceBound(
        url: URL,
        when: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) throws {
        var object = try readMergingObject(at: url)
        object["deviceBoundAt"] = NSNumber(value: when)
        try writePrivateObject(object, at: url)
    }

    private static func readMergingObject(at url: URL) throws -> [String: Any] {
        let fm = FileManager.default
        let directory = url.deletingLastPathComponent()
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        guard fm.fileExists(atPath: url.path) else { return [:] }

        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey])
        guard values.isSymbolicLink != true else {
            throw CocoaError(.fileWriteNoPermission)
        }
        guard (values.fileSize ?? 0) <= maximumExistingBytes else {
            throw CocoaError(.fileReadTooLarge)
        }
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url)))
            as? [String: Any] ?? [:]
    }

    private static func writePrivateObject(_ object: [String: Any], at url: URL) throws {
        let fm = FileManager.default
        let directory = url.deletingLastPathComponent()
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
    }
}
