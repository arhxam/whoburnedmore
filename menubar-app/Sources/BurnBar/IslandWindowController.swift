import AppKit
import BurnBarCore
import QuartzCore
import SwiftUI

@MainActor
final class IslandWindowController: NSObject {
    private let model: AppModel
    private let settings: SettingsStore
    private let compactPanel: IslandPanel
    private let expandedPanel: IslandPanel
    private let presentation: IslandPresentationModel
    private var activeScreen: NSScreen
    private var globalEventMonitor: Any?
    private var localClickMonitor: Any?
    private var localKeyMonitor: Any?
    private var pointerTimer: Timer?
    private var screenObserver: NSObjectProtocol?
    private var hideRevealWorkItem: DispatchWorkItem?
    private var primaryButtonWasDown = false

    init?(model: AppModel, settings: SettingsStore, screen: NSScreen?) {
        guard let screen = screen ?? NSScreen.main ?? NSScreen.screens.first else { return nil }
        self.model = model
        self.settings = settings
        activeScreen = screen

        let layout = IslandLayoutCalculator.layout(for: Self.geometry(for: screen))
        presentation = IslandPresentationModel(layout: layout)
        compactPanel = IslandPanel(
            contentRect: layout.compactFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        expandedPanel = IslandPanel(
            contentRect: layout.expandedFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        configure(compactPanel)
        configure(expandedPanel)
        installEventMonitors()
        installScreenObserver()
    }

    /// Idle means no notch window at all. The status item remains present and a
    /// permission-free pointer sampler reveals the compact panel on demand.
    func showCompact() {
        presentation.state = .dormant
        compactPanel.orderOut(nil)
        expandedPanel.orderOut(nil)
    }

    func toggle(on screen: NSScreen? = nil) {
        apply(.toggle, on: screen)
    }

    func expand(on screen: NSScreen? = nil) {
        apply(.expand, on: screen)
    }

    func reveal(on screen: NSScreen? = nil) {
        apply(.pointerEntered, on: screen)
    }

    func collapse() {
        apply(.collapse, on: nil)
    }

    func armScreenshot() {
        let screenshotState: IslandPresentationState =
            ProcessInfo.processInfo.environment["BURNBAR_ISLAND_SCREENSHOT_STATE"] == "compact"
            ? .revealed
            : .expanded
        let previewPresentation = IslandPresentationModel(
            state: screenshotState,
            layout: presentation.layout
        )
        let screenshotFrame = targetFrame(for: screenshotState)
        WindowShot.arm(envKey: "BURNBAR_ISLAND_SCREENSHOT") { [model, settings] in
            IslandSurfaceView(
                presentation: previewPresentation,
                model: model,
                settings: settings,
                onToggle: {},
                renderStatic: true
            )
            .frame(width: screenshotFrame.width, height: screenshotFrame.height)
        }
    }

    func tearDown() {
        hideRevealWorkItem?.cancel()
        pointerTimer?.invalidate()
        if let globalEventMonitor { NSEvent.removeMonitor(globalEventMonitor) }
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
        if let localKeyMonitor { NSEvent.removeMonitor(localKeyMonitor) }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        compactPanel.close()
        expandedPanel.close()
    }

    /// Each endpoint owns a fixed-size panel. NSHostingView never negotiates a
    /// live NSWindow resize, eliminating the recursive AppKit layout crash and
    /// the snap-back that previously made the dashboard appear not to open.
    private func configure(_ panel: IslandPanel) {
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.ignoresMouseEvents = true

        let root = IslandSurfaceView(
            presentation: presentation,
            model: model,
            settings: settings,
            onToggle: { [weak self] in self?.toggle() }
        )
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        hosting.safeAreaRegions = []
        hosting.frame = CGRect(origin: .zero, size: panel.frame.size)
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting
    }

    private func apply(_ action: IslandPresentationAction, on requestedScreen: NSScreen?) {
        if let requestedScreen, requestedScreen != activeScreen {
            activeScreen = requestedScreen
            updateLayout(for: requestedScreen)
        }

        let next = IslandPresentationReducer.reduce(presentation.state, action: action)
        guard next != presentation.state else { return }

        hideRevealWorkItem?.cancel()
        withAnimation {
            presentation.state = next
        }
        refreshPointerTimer()

        switch next {
        case .dormant:
            compactPanel.ignoresMouseEvents = true
            compactPanel.orderOut(nil)
            expandedPanel.orderOut(nil)
        case .revealed:
            expandedPanel.orderOut(nil)
            compactPanel.ignoresMouseEvents = false
            compactPanel.orderFrontRegardless()
        case .expanded:
            compactPanel.orderOut(nil)
            expandedPanel.ignoresMouseEvents = false
            expandedPanel.orderFrontRegardless()
            animateExpansion()
            Task { await model.refreshRemote() }
        }
    }

    /// The panel keeps its final fixed frame (avoiding AppKit/SwiftUI resize
    /// negotiation) while its layer grows down from the camera footprint.
    /// Reduce Motion skips displacement and leaves only SwiftUI's near-instant
    /// state change.
    private func animateExpansion() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
              let layer = expandedPanel.contentView?.layer else { return }

        let compact = presentation.layout.compactFrame.size
        let expanded = presentation.layout.expandedFrame.size
        let scaleX = max(0.01, compact.width / expanded.width)
        let scaleY = max(0.01, compact.height / expanded.height)
        let collapsed = CATransform3DMakeScale(scaleX, scaleY, 1)

        let frame = layer.frame
        layer.anchorPoint = CGPoint(x: 0.5, y: 1)
        layer.position = CGPoint(x: frame.midX, y: frame.maxY)
        layer.transform = CATransform3DIdentity
        layer.opacity = 1

        let transform = CABasicAnimation(keyPath: "transform")
        transform.fromValue = NSValue(caTransform3D: collapsed)
        transform.toValue = NSValue(caTransform3D: CATransform3DIdentity)

        let opacity = CABasicAnimation(keyPath: "opacity")
        opacity.fromValue = 0.82
        opacity.toValue = 1

        let group = CAAnimationGroup()
        group.animations = [transform, opacity]
        group.duration = 0.32
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(group, forKey: "burnbar-expand")
    }

    private func targetFrame(for state: IslandPresentationState) -> CGRect {
        switch state {
        case .dormant: return presentation.layout.triggerFrame
        case .revealed: return presentation.layout.compactFrame
        case .expanded: return presentation.layout.expandedFrame
        }
    }

    private func installEventMonitors() {
        if ProcessInfo.processInfo.environment["BURNBAR_ISLAND_DISABLE_AUTO_COLLAPSE"] != "1" {
            globalEventMonitor = NSEvent.addGlobalMonitorForEvents(
                matching: [.leftMouseDown, .rightMouseDown]
            ) { [weak self] event in
                Task { @MainActor [weak self] in self?.handleGlobalEvent(event) }
            }

            refreshPointerTimer()

            localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self,
                      self.presentation.state == .revealed,
                      self.compactPanel.frame.contains(NSEvent.mouseLocation) else { return event }
                self.apply(.toggle, on: nil)
                return nil
            }
        }

        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, self?.presentation.state == .expanded else { return event }
            self?.apply(.escape, on: nil)
            return nil
        }
    }

    private func refreshPointerTimer() {
        pointerTimer?.invalidate()
        pointerTimer = nil
        guard ProcessInfo.processInfo.environment["BURNBAR_ISLAND_DISABLE_AUTO_COLLAPSE"] != "1",
              let interval = PointerSamplingPolicy.interval(for: presentation.state) else { return }

        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            // This timer is installed only on the main run loop. Avoid creating
            // a new unstructured Task on every pointer sample.
            MainActor.assumeIsolated {
                self?.samplePointerAndButton()
            }
        }
        pointerTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func handleGlobalEvent(_: NSEvent) {
        let point = NSEvent.mouseLocation
        if presentation.state == .revealed, compactPanel.frame.contains(point) {
            apply(.toggle, on: nil)
            return
        }
        guard presentation.state == .expanded, !expandedPanel.frame.contains(point) else { return }
        apply(.outsideClick, on: nil)
    }

    private func handlePointer(at point: CGPoint) {
        switch presentation.state {
        case .dormant:
            guard let screen = Self.screen(at: point) else { return }
            let layout = IslandLayoutCalculator.layout(for: Self.geometry(for: screen))
            guard layout.triggerFrame.contains(point) else { return }
            apply(.pointerEntered, on: screen)
        case .revealed:
            let generousFrame = compactPanel.frame.insetBy(dx: -4, dy: -4)
            if generousFrame.contains(point) {
                hideRevealWorkItem?.cancel()
                return
            }
            scheduleRevealHide()
        case .expanded:
            break
        }
    }

    /// The camera housing is not a normal display region, so AppKit may not
    /// route its clicks to any window. Sampling the physical button state keeps
    /// the interaction permission-free and makes the revealed camera footprint
    /// reliably clickable.
    private func samplePointerAndButton() {
        let point = NSEvent.mouseLocation
        handlePointer(at: point)

        let primaryButtonIsDown = (NSEvent.pressedMouseButtons & 1) == 1
        if primaryButtonIsDown, !primaryButtonWasDown,
           presentation.state == .revealed, compactPanel.frame.contains(point) {
            primaryButtonWasDown = true
            apply(.toggle, on: nil)
            return
        }
        primaryButtonWasDown = primaryButtonIsDown
    }

    private func scheduleRevealHide() {
        guard hideRevealWorkItem == nil || hideRevealWorkItem?.isCancelled == true else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.presentation.state == .revealed,
                  !self.compactPanel.frame.insetBy(dx: -4, dy: -4).contains(NSEvent.mouseLocation) else { return }
            self.apply(.pointerExited, on: nil)
        }
        hideRevealWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22, execute: item)
    }

    private func installScreenObserver() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshScreenGeometry() }
        }
    }

    private func refreshScreenGeometry() {
        guard NSScreen.screens.contains(activeScreen) else {
            activeScreen = Self.screenUnderPointer() ?? NSScreen.main ?? NSScreen.screens[0]
            return refreshScreenGeometry()
        }
        updateLayout(for: activeScreen)
    }

    private func updateLayout(for screen: NSScreen) {
        let layout = IslandLayoutCalculator.layout(for: Self.geometry(for: screen))
        presentation.layout = layout
        compactPanel.setFrame(layout.compactFrame, display: false)
        expandedPanel.setFrame(layout.expandedFrame, display: false)
    }

    static func screenUnderPointer() -> NSScreen? {
        screen(at: NSEvent.mouseLocation)
    }

    private static func screen(at point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) }
    }

    private static func geometry(for screen: NSScreen) -> IslandScreenGeometry {
        IslandScreenGeometry(
            frame: screen.frame,
            visibleFrame: screen.visibleFrame,
            safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryTopLeftArea: screen.auxiliaryTopLeftArea,
            auxiliaryTopRightArea: screen.auxiliaryTopRightArea
        )
    }
}

private final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
