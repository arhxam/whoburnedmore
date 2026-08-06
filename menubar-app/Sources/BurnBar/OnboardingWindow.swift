import AppKit
import BurnBarCore
import SwiftUI

/// First-run welcome: local tracking starts immediately, while every capability
/// that asks macOS for access remains an explicit user choice.
@MainActor
enum OnboardingWindow {
    private static var window: NSWindow?

    static func showIfNeeded(model: AppModel, settings: SettingsStore) {
        guard !settings.onboardingDone, window == nil else { return }
        let hosting = NSHostingController(
            rootView: OnboardingView().environmentObject(model).environmentObject(settings)
        )
        hosting.sizingOptions = []  // see DebugWindow: sizing negotiation loops
        let w = NSWindow(contentViewController: hosting)
        w.title = "Welcome to BurnBar"
        w.setContentSize(NSSize(width: 520, height: 650))
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w
        WindowShot.arm { OnboardingView().environmentObject(model).environmentObject(settings).frame(width: 520).environment(\.colorScheme, .dark).background(Color(red: 0.11, green: 0.11, blue: 0.125)) }
    }

    static func close() {
        window?.close()
        window = nil
    }
}

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @State private var launchAtLogin = LaunchAtLogin.isEnabled

    /// Cheap synchronous detection — good enough for the welcome chips; the
    /// live snapshot refines it seconds later.
    static func detectTools() -> [(name: String, found: Bool)] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let fm = FileManager.default
        func has(_ path: String) -> Bool { fm.fileExists(atPath: home.appendingPathComponent(path).path) }
        return [
            ("Claude Code", has(".claude") || has(".config/claude")),
            ("Codex", has(".codex")),
            ("Cursor", has("Library/Application Support/Cursor")),
            ("Cline/Roo", has("Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev")
                || has("Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline")),
            ("Continue", has(".continue")),
        ]
    }

    private let tools = Self.detectTools()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                BurnFlame(size: 20)
                Text("BurnBar is watching your burn").font(.title2.weight(.bold))
            }
            Text("AI tools found — live tracking is already running on-device:")
                .foregroundStyle(.secondary)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 8) {
                ForEach(tools, id: \.name) { tool in
                    HStack(spacing: 4) {
                        Image(systemName: tool.found ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(tool.found ? .green : .secondary)
                        Text(tool.name).font(.callout)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                    .opacity(tool.found ? 1 : 0.5)
                }
            }

            Divider()

            Text("Choose what BurnBar may do").font(.headline)
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        LaunchAtLogin.set(on)
                        launchAtLogin = LaunchAtLogin.isEnabled
                    }
                Text("Recommended for uninterrupted local history after a restart.")
                    .font(.caption).foregroundStyle(.secondary)

                HStack {
                    Button(settings.notificationsEnabled ? "Notifications enabled ✓" : "Enable notifications") {
                        model.setNotificationsEnabled(true)
                    }
                    .disabled(settings.notificationsEnabled)
                    Text("Limit, reset, and daily-rank alerts")
                        .font(.caption).foregroundStyle(.secondary)
                }

                HStack {
                    Button(settings.claudeLimitsEnabled ? "Claude limits enabled ✓" : "Enable Claude limits") {
                        Task { await model.setClaudeLimitsEnabled(true) }
                    }
                    .buttonStyle(.borderedProminent).tint(.orange)
                    .disabled(settings.claudeLimitsEnabled)
                    Text("Read-only Keychain access")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Codex limits are read locally from Codex session files and need no additional permission.")
                    .font(.caption).foregroundStyle(.secondary)

                Toggle("Keep my leaderboard total in sync", isOn: Binding(
                    get: { settings.syncEnabled },
                    set: { model.setLeaderboardSyncEnabled($0) }
                ))
                Text("Optional. Uploads token totals—not prompts or code—when you are signed in.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Divider()

            Label {
                Text("Optional: get ranked").font(.headline)
            } icon: { Image(systemName: "trophy.fill").foregroundStyle(.orange) }
            Text("See your live daily rank and nearby burners. BurnBar works without an account.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("See the leaderboard ↗") {
                    if let url = URL(string: "https://whoburnedmore.com") { NSWorkspace.shared.open(url) }
                }
                Button("Connect account") {
                    settings.onboardingDone = true
                    OnboardingWindow.close()
                    SettingsWindow.show(model: model, settings: settings)
                }
                Spacer()
                Button("Done") {
                    settings.onboardingDone = true
                    OnboardingWindow.close()
                }
                .buttonStyle(.borderedProminent).tint(.orange)
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}
