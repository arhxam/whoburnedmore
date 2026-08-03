import BurnBarCore
import SwiftUI

@main
struct BurnBarApp: App {
    @StateObject private var model: AppModel
    @StateObject private var settings: SettingsStore

    init() {
        let s = SettingsStore()
        _settings = StateObject(wrappedValue: s)
        _model = StateObject(wrappedValue: AppModel(settings: s))
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environmentObject(model)
                .environmentObject(settings)
                .onAppear { Task { await model.refreshRemote() } }
        } label: {
            MenuBarLabel(text: model.menuBarText, state: model.meterState)
                .environmentObject(model)
                .environmentObject(settings)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The status-item content. Its onAppear fires exactly once at launch, which
/// makes it the reliable place to boot the engines (App.init runs before the
/// main actor is fully set up; onAppear is on the main actor).
struct MenuBarLabel: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    let text: String?
    let state: MeterState

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: iconName)
            if let text {
                Text(text)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            }
        }
        .onAppear {
            model.startIfNeeded()
            let env = ProcessInfo.processInfo.environment
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
        }
    }

    private var iconName: String {
        switch state {
        case .normal: return "flame"
        case .amber: return "flame.fill"
        case .critical: return "exclamationmark.triangle.fill"
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
            Image(systemName: state == .critical ? "exclamationmark.triangle.fill" : (state == .amber ? "flame.fill" : "flame"))
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
