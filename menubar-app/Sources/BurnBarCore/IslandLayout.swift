import CoreGraphics
import Foundation

/// Screen measurements needed by the island, separated from `NSScreen` so the
/// layout stays deterministic and independently testable.
public struct IslandScreenGeometry: Sendable {
    public let frame: CGRect
    public let visibleFrame: CGRect
    public let safeAreaTop: CGFloat
    public let auxiliaryTopLeftArea: CGRect?
    public let auxiliaryTopRightArea: CGRect?

    public init(
        frame: CGRect,
        visibleFrame: CGRect,
        safeAreaTop: CGFloat,
        auxiliaryTopLeftArea: CGRect?,
        auxiliaryTopRightArea: CGRect?
    ) {
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.safeAreaTop = safeAreaTop
        self.auxiliaryTopLeftArea = auxiliaryTopLeftArea
        self.auxiliaryTopRightArea = auxiliaryTopRightArea
    }
}

public struct IslandLayout: Sendable {
    public let triggerFrame: CGRect
    public let compactFrame: CGRect
    public let expandedFrame: CGRect
    public let notchFrame: CGRect?

    public var hasNotch: Bool { notchFrame != nil }
}

public enum IslandLayoutCalculator {
    private static let horizontalScreenMargin: CGFloat = 12
    private static let fallbackCompactWidth: CGFloat = 120
    private static let fallbackTriggerHeight: CGFloat = 28
    private static let fallbackCompactHeight: CGFloat = 40
    private static let notchTriggerExtension: CGFloat = 12
    private static let notchRevealExtension: CGFloat = 22
    private static let preferredExpandedWidth: CGFloat = 404
    private static let preferredExpandedHeight: CGFloat = 590
    private static let bottomMargin: CGFloat = 24
    private static let fallbackTopMargin: CGFloat = 6

    public static func layout(for screen: IslandScreenGeometry) -> IslandLayout {
        let notch = notchFrame(for: screen)
        let topMargin = notch == nil ? fallbackTopMargin : 0
        let topEdge = screen.frame.maxY - topMargin
        let maximumWidth = max(1, screen.frame.width - horizontalScreenMargin * 2)

        let compactWidth = min(notch?.width ?? fallbackCompactWidth, maximumWidth)
        let triggerHeight = notch.map { $0.height + notchTriggerExtension } ?? fallbackTriggerHeight
        let compactHeight = notch.map { $0.height + notchRevealExtension } ?? fallbackCompactHeight
        let triggerSize = CGSize(width: compactWidth, height: triggerHeight)
        let triggerFrame = notch.map {
            CGRect(x: $0.minX, y: topEdge - triggerHeight, width: compactWidth, height: triggerHeight)
        } ?? topCenteredFrame(size: triggerSize, topEdge: topEdge, screen: screen.frame)
        let compactSize = CGSize(width: compactWidth, height: compactHeight)
        let compactFrame = notch.map {
            CGRect(x: $0.minX, y: topEdge - compactHeight, width: compactWidth, height: compactHeight)
        } ?? topCenteredFrame(size: compactSize, topEdge: topEdge, screen: screen.frame)

        let expandedWidth = min(preferredExpandedWidth, maximumWidth)
        let availableHeight = max(
            compactHeight,
            topEdge - (screen.visibleFrame.minY + bottomMargin)
        )
        let expandedHeight = min(preferredExpandedHeight, availableHeight)
        let expandedSize = CGSize(width: expandedWidth, height: expandedHeight)
        let expandedFrame = topCenteredFrame(size: expandedSize, topEdge: topEdge, screen: screen.frame)

        return IslandLayout(
            triggerFrame: triggerFrame,
            compactFrame: compactFrame,
            expandedFrame: expandedFrame,
            notchFrame: notch
        )
    }

    private static func notchFrame(for screen: IslandScreenGeometry) -> CGRect? {
        guard screen.safeAreaTop > 0,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea,
              right.minX > left.maxX else {
            return nil
        }

        return CGRect(
            x: left.maxX,
            y: screen.frame.maxY - screen.safeAreaTop,
            width: right.minX - left.maxX,
            height: screen.safeAreaTop
        )
    }

    private static func topCenteredFrame(size: CGSize, topEdge: CGFloat, screen: CGRect) -> CGRect {
        let originX = screen.midX - size.width / 2
        return CGRect(x: originX, y: topEdge - size.height, width: size.width, height: size.height)
    }
}
