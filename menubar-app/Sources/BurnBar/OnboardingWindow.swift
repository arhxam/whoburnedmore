import AppKit
import BurnBarCore
import SwiftUI

/// First-run welcome: shows what was detected, offers the one-time Claude
/// limits opt-in, and a soft whoburnedmore upsell. Never blocks the app —
/// tracking already started before this window appears.
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
        w.setContentSize(NSSize(width: 480, height: 560))
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w
        WindowShot.arm { OnboardingView().environmentObject(model).environmentObject(settings).frame(width: 480).environment(\.colorScheme, .dark).background(Color(red: 0.11, green: 0.11, blue: 0.125)) }
    }

    static func close() {
        window?.close()
        window = nil
    }
}

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @State private var limitsEnabled = false

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
            Text("🔥 BurnBar is watching your burn")
                .font(.title2.weight(.bold))
            Text("Found these AI coding tools — live tracking already started, entirely on-device:")
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
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

            Text("Want your Claude 5h-window limits too?").font(.headline)
            Text("Needs one read-only Keychain approval — the token never leaves your Mac. macOS may ask once; choose \"Always Allow\".")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button(limitsEnabled ? "Limits enabled ✓" : "Enable limits") {
                    Task {
                        await model.refreshRemote()
                        limitsEnabled = true
                    }
                }
                .buttonStyle(.borderedProminent).tint(.orange)
                .disabled(limitsEnabled)
            }

            Divider()

            Text("Optional: get ranked 🏆").font(.headline)
            Text("whoburnedmore.com is the public leaderboard of AI token burners. One click to join — or ignore this forever; BurnBar works fully without it.")
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
        .frame(width: 480)
    }
}
