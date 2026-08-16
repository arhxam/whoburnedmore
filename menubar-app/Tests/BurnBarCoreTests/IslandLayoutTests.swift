import XCTest
@testable import BurnBarCore

final class IslandLayoutTests: XCTestCase {
    private let builtIn = IslandScreenGeometry(
        frame: CGRect(x: 0, y: 0, width: 1470, height: 956),
        visibleFrame: CGRect(x: 0, y: 0, width: 1470, height: 923),
        safeAreaTop: 32,
        auxiliaryTopLeftArea: CGRect(x: 0, y: 924, width: 646, height: 32),
        auxiliaryTopRightArea: CGRect(x: 825, y: 924, width: 645, height: 32)
    )

    func testNotchedDisplayUsesMeasuredCameraHousing() {
        let layout = IslandLayoutCalculator.layout(for: builtIn)

        XCTAssertEqual(layout.notchFrame, CGRect(x: 646, y: 924, width: 179, height: 32))
        XCTAssertEqual(layout.triggerFrame, CGRect(x: 646, y: 912, width: 179, height: 44))
        XCTAssertEqual(layout.compactFrame.width, 179)
        XCTAssertEqual(layout.compactFrame.height, 54)
        XCTAssertEqual(layout.compactFrame.midX, layout.notchFrame?.midX)
        XCTAssertEqual(layout.compactFrame.maxY, builtIn.frame.maxY)
        XCTAssertEqual(layout.expandedFrame.height, 590)
        XCTAssertTrue(layout.hasNotch)
    }

    func testNonNotchedDisplayUsesFloatingPillFallback() {
        let external = IslandScreenGeometry(
            frame: CGRect(x: -1162, y: 956, width: 3440, height: 1440),
            visibleFrame: CGRect(x: -1162, y: 956, width: 3440, height: 1410),
            safeAreaTop: 0,
            auxiliaryTopLeftArea: nil,
            auxiliaryTopRightArea: nil
        )

        let layout = IslandLayoutCalculator.layout(for: external)

        XCTAssertNil(layout.notchFrame)
        XCTAssertEqual(layout.triggerFrame.size, CGSize(width: 120, height: 28))
        XCTAssertEqual(layout.compactFrame.size, CGSize(width: 120, height: 40))
        XCTAssertEqual(layout.compactFrame.midX, external.frame.midX)
        XCTAssertEqual(layout.compactFrame.maxY, external.frame.maxY - 6)
        XCTAssertFalse(layout.hasNotch)
    }

    func testExpandedFrameStaysTopCenteredAndClampsToSmallScreen() {
        let small = IslandScreenGeometry(
            frame: CGRect(x: 100, y: 50, width: 360, height: 500),
            visibleFrame: CGRect(x: 100, y: 80, width: 360, height: 440),
            safeAreaTop: 0,
            auxiliaryTopLeftArea: nil,
            auxiliaryTopRightArea: nil
        )

        let layout = IslandLayoutCalculator.layout(for: small)

        XCTAssertEqual(layout.expandedFrame.width, 336)
        XCTAssertEqual(layout.expandedFrame.height, 440)
        XCTAssertEqual(layout.expandedFrame.midX, small.frame.midX)
        XCTAssertEqual(layout.expandedFrame.maxY, small.frame.maxY - 6)
        XCTAssertGreaterThanOrEqual(layout.expandedFrame.minX, small.frame.minX + 12)
        XCTAssertGreaterThanOrEqual(layout.expandedFrame.minY, small.visibleFrame.minY + 24)
    }
}

final class IslandPresentationTests: XCTestCase {
    func testPointerSamplingAdaptsToInteractionState() {
        XCTAssertEqual(PointerSamplingPolicy.interval(for: .dormant), 0.2)
        XCTAssertEqual(PointerSamplingPolicy.interval(for: .revealed), 0.03)
        XCTAssertNil(PointerSamplingPolicy.interval(for: .expanded))
    }

    func testPointerOnlyRevealsCompactValueFromDormantState() {
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.dormant, action: .pointerEntered),
            .revealed
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.revealed, action: .pointerExited),
            .dormant
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.expanded, action: .pointerExited),
            .expanded
        )
    }

    func testToggleMovesBetweenDormantAndExpanded() {
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.dormant, action: .toggle),
            .expanded
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.expanded, action: .toggle),
            .dormant
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.revealed, action: .toggle),
            .expanded
        )
    }

    func testExplicitExpandIsIdempotent() {
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.dormant, action: .expand),
            .expanded
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.expanded, action: .expand),
            .expanded
        )
    }

    func testEscapeAndOutsideClickCollapse() {
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.expanded, action: .escape),
            .dormant
        )
        XCTAssertEqual(
            IslandPresentationReducer.reduce(.expanded, action: .outsideClick),
            .dormant
        )
    }
}
