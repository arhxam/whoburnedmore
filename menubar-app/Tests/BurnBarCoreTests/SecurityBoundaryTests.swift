import Foundation
import XCTest
@testable import BurnBarCore

final class SecurityBoundaryTests: XCTestCase {
    func testServiceOriginRequiresHTTPSOrExplicitLoopbackHTTP() {
        XCTAssertEqual(
            TrustedWebURL.serviceOrigin("https://api.whoburnedmore.com")?.absoluteString,
            "https://api.whoburnedmore.com"
        )
        XCTAssertEqual(
            TrustedWebURL.serviceOrigin("http://127.0.0.1:3001")?.absoluteString,
            "http://127.0.0.1:3001"
        )
        XCTAssertNil(TrustedWebURL.serviceOrigin("http://api.whoburnedmore.com"))
        XCTAssertNil(TrustedWebURL.serviceOrigin("https://user:pass@api.whoburnedmore.com"))
        XCTAssertNil(TrustedWebURL.serviceOrigin("https://api.whoburnedmore.com/prefix"))
        XCTAssertNil(TrustedWebURL.serviceOrigin("file:///tmp/socket"))
    }

    func testBoundedDataAccumulatorStopsAtTheConfiguredCeiling() throws {
        var accumulator = BoundedDataAccumulator(maxBytes: 4)
        try accumulator.append(1)
        try accumulator.append(2)
        try accumulator.append(3)
        try accumulator.append(4)
        XCTAssertEqual(accumulator.data, Data([1, 2, 3, 4]))
        XCTAssertThrowsError(try accumulator.append(5))
    }

    func testDeviceVerificationURLRequiresExactTrustedHTTPSOrigin() {
        let base = URL(string: "https://whoburnedmore.com")!
        XCTAssertEqual(
            TrustedWebURL.deviceVerification(
                "https://whoburnedmore.com/cli?code=ABCD-EFGH",
                allowedBase: base
            )?.absoluteString,
            "https://whoburnedmore.com/cli?code=ABCD-EFGH"
        )
        XCTAssertNil(TrustedWebURL.deviceVerification("http://whoburnedmore.com/cli", allowedBase: base))
        XCTAssertNil(TrustedWebURL.deviceVerification("https://evil.example/cli", allowedBase: base))
        XCTAssertNil(TrustedWebURL.deviceVerification("file:///tmp/payload", allowedBase: base))
        XCTAssertNil(TrustedWebURL.deviceVerification("burnbar://payload", allowedBase: base))
        XCTAssertNil(
            TrustedWebURL.deviceVerification(
                "https://whoburnedmore.com.evil.example/cli",
                allowedBase: base
            )
        )
        XCTAssertNil(
            TrustedWebURL.deviceVerification(
                "https://attacker@whoburnedmore.com/cli",
                allowedBase: base
            )
        )
    }

    func testDeviceVerificationURLAllowsExplicitLocalHTTPDevelopmentOriginOnly() {
        let local = URL(string: "http://127.0.0.1:3098")!
        XCTAssertNotNil(
            TrustedWebURL.deviceVerification(
                "http://127.0.0.1:3098/cli?code=ABCD",
                allowedBase: local
            )
        )
        XCTAssertNil(
            TrustedWebURL.deviceVerification(
                "http://127.0.0.1:4000/cli?code=ABCD",
                allowedBase: local
            )
        )
    }

    func testNDJSONFramerEmitsCompleteLinesAcrossChunks() throws {
        var framer = BoundedNDJSONFramer(maxFrameBytes: 64)
        XCTAssertEqual(try framer.append(Data("{\"a\":".utf8)), [])
        XCTAssertEqual(
            try framer.append(Data("1}\n{\"b\":2}\n".utf8)),
            ["{\"a\":1}", "{\"b\":2}"]
        )
        XCTAssertEqual(framer.pendingByteCount, 0)
    }

    func testNDJSONFramerRejectsAnUnterminatedOversizedFrameAndRecovers() throws {
        var framer = BoundedNDJSONFramer(maxFrameBytes: 16)
        XCTAssertThrowsError(try framer.append(Data(repeating: 0x61, count: 17)))
        XCTAssertEqual(framer.pendingByteCount, 0)
        XCTAssertEqual(try framer.append(Data("{\"ok\":true}\n".utf8)), ["{\"ok\":true}"])
    }
}
