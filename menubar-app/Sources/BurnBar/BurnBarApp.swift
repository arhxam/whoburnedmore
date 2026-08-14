import BurnBarCore
import SwiftUI

@main
struct BurnBarApp: App {
    @NSApplicationDelegateAdaptor(BurnBarApplicationDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class BurnBarApplicationDelegate: NSObject, NSApplicationDelegate {
    private var model: AppModel?
    private var settings: SettingsStore?
    private var updates: UpdateController?
    private var island: IslandWindowController?
    private var statusItem: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Start update scheduling independently from window/screen setup. An
        // unavailable display must never prevent BurnBar from staying current.
        let updates = UpdateController.shared
        self.updates = updates
        let settings = SettingsStore()
        let model = AppModel(settings: settings)
        self.settings = settings
        self.model = model

        let env = ProcessInfo.processInfo.environment
        if env["BURNBAR_CHECK_FOR_UPDATES_ON_LAUNCH"] == "1" {
            DispatchQueue.main.async { updates.checkForUpdates() }
        }
        let requestedScreen: NSScreen? = {
            switch env["BURNBAR_ISLAND_SCREEN"] {
            case "notched": return NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
            case "external": return NSScreen.screens.first { $0.safeAreaInsets.top == 0 }
            default: return IslandWindowController.screenUnderPointer()
            }
        }()
        guard let island = IslandWindowController(
            model: model,
            settings: settings,
            screen: requestedScreen
        ) else { return }
        self.island = island
        statusItem = StatusItemController(model: model, settings: settings) { [weak island] in
            island?.toggle(on: IslandWindowController.screenUnderPointer())
        }

        model.startIfNeeded()
        island.showCompact()
        island.armScreenshot()

        if env["BURNBAR_DEBUG_WINDOW"] == "1" {
            DebugWindow.show(model: model, settings: settings)
        }
        if env["BURNBAR_OPEN_SETTINGS"] == "1" {
            SettingsWindow.show(model: model, settings: settings)
        }
        OnboardingWindow.showIfNeeded(model: model, settings: settings)
        WindowShot.arm(envKey: "BURNBAR_SHOT_MENUBAR") { [weak model] in
            MenuBarRenderPreview(
                text: model?.menuBarText,
                state: model?.meterState ?? .normal
            )
        }

        let shouldOpenExpanded = env["BURNBAR_ISLAND_EXPANDED"] == "1"
            || CommandLine.arguments.contains("--expanded")
        if shouldOpenExpanded {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak island] in
                island?.expand()
            }
        } else if env["BURNBAR_ISLAND_REVEALED"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak island] in
                island?.reveal()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusItem?.remove()
        island?.tearDown()
    }
}

/// Shared visual content for the native status item and its verification render.
struct MenuBarLabel: View {
    let text: String?
    let state: MeterState

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: state.iconName)
            if let text {
                Text(text)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            }
        }
    }

}


/// Offscreen-renderable copy of the status-item content (for verification
/// shots when the physical menu bar can't be captured — locked display).
struct MenuBarRenderPreview: View {
    let text: String?
    let state: MeterState

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: state.iconName)
            if let text {
                Text(text).font(.system(size: 12, weight: .medium, design: .monospaced))
            }
        }
        .foregroundStyle(state == .critical ? Color.red : (state == .amber ? Color.orange : Color.primary))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .environment(\.colorScheme, .dark)
        .background(Color(red: 0.18, green: 0.18, blue: 0.2))
    }
}
