import AppKit
import BurnBarCore
import SwiftUI

/// Verification aid: BURNBAR_DEBUG_WINDOW=1 renders the popover content in a
/// floating, always-on-top window at a fixed position so headless checks can
/// screencapture it deterministically. Never shown in normal operation.
@MainActor
enum DebugWindow {
    private static var window: NSWindow?

    static func show(model: AppModel, settings: SettingsStore) {
        guard window == nil else { return }
        let hosting = NSHostingController(
            rootView: PopoverView().environmentObject(model).environmentObject(settings)
        )
        hosting.sizingOptions = []  // no SwiftUI<->AppKit size negotiation: it loops (v2 bisect)
        let w = NSWindow(contentViewController: hosting)
        w.title = "BurnBar Debug"
        w.setContentSize(NSSize(width: 330, height: 700))
        w.styleMask = [.titled]
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.setFrameTopLeftPoint(NSPoint(x: 40, y: (NSScreen.main?.frame.height ?? 900) - 40))
        w.orderFrontRegardless()
        window = w
        NSApp.activate(ignoringOtherApps: true)
        WindowShot.arm { PopoverView().environmentObject(model).environmentObject(settings).frame(width: 330).environment(\.colorScheme, .dark).background(Color(red: 0.11, green: 0.11, blue: 0.125)) }
    }
}
