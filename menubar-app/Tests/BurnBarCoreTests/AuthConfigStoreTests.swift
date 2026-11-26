import BurnBarCore
import Foundation
import XCTest

final class AuthConfigStoreTests: XCTestCase {
    func testPersistsRefreshCredentialAtomicallyWithOwnerOnlyPermissions() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("burnbar-auth-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("config.json")
        try Data("{\"anonKey\":\"existing\",\"unknown\":7}".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)

        let anonKey = try AuthConfigStore.persist(
            url: url,
            token: "access",
            refreshToken: "refresh",
            handle: "alice"
        )

        XCTAssertEqual(anonKey, "existing")
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        XCTAssertEqual(obj["cliToken"] as? String, "access")
        XCTAssertEqual(obj["refreshToken"] as? String, "refresh")
        XCTAssertEqual(obj["handle"] as? String, "alice")
        XCTAssertEqual(obj["unknown"] as? Int, 7)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testRefusesToReadOrOverwriteASymlinkedCredentialFile() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("burnbar-auth-link-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let victim = root.appendingPathComponent("victim")
        try Data("unchanged".utf8).write(to: victim)
        let link = root.appendingPathComponent("config.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: victim)

        XCTAssertThrowsError(
            try AuthConfigStore.persist(
                url: link,
                token: "access",
                refreshToken: "refresh",
                handle: "alice"
            )
        )
        XCTAssertThrowsError(try AuthConfigStore.recordDeviceBound(url: link, when: 1))
        XCTAssertEqual(try String(contentsOf: victim, encoding: .utf8), "unchanged")
    }

    func testRecordDeviceBoundKeepsTheSignInAndOwnerOnlyMode() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("burnbar-bound-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("config.json")
        _ = try AuthConfigStore.persist(
            url: url,
            token: "access",
            refreshToken: "refresh",
            handle: "alice"
        )

        try AuthConfigStore.recordDeviceBound(url: url, when: 1_700_000_000_000)

        let stamped = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        XCTAssertEqual(stamped["cliToken"] as? String, "access")
        XCTAssertEqual(stamped["refreshToken"] as? String, "refresh")
        XCTAssertEqual(stamped["handle"] as? String, "alice")
        XCTAssertEqual((stamped["deviceBoundAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        _ = try AuthConfigStore.persist(
            url: url,
            token: "replaced",
            refreshToken: "refresh",
            handle: "alice"
        )
        let rewritten = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        XCTAssertEqual(rewritten["cliToken"] as? String, "replaced")
        XCTAssertEqual((rewritten["deviceBoundAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)
    }
}
