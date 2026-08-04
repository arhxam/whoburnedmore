import AppKit
import BurnBarCore
import SwiftUI

/// The real Settings window. NOT the stock SwiftUI `Settings` scene — that one
/// is tiny and macOS decides which screen it appears on (the exact complaint).
/// This is our own NSWindow: 720×520, centered on the screen the mouse is on,
/// reused across opens, floating above the popover flow.
@MainActor
enum SettingsWindow {
    private static var window: NSWindow?

    static func show(model: AppModel, settings: SettingsStore) {
        NSApp.activate(ignoringOtherApps: true)
        if let window {
            center(window)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let hosting = NSHostingController(
            rootView: SettingsRootView().environmentObject(model).environmentObject(settings)
        )
        hosting.sizingOptions = []  // see DebugWindow: sizing negotiation loops
        let w = NSWindow(contentViewController: hosting)
        w.title = "BurnBar Settings"
        w.styleMask = [.titled, .closable, .miniaturizable]
        w.setContentSize(NSSize(width: 720, height: 520))
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        center(w)
        w.makeKeyAndOrderFront(nil)
        window = w
        logFrame(w)
        WindowShot.arm { SettingsRootView(renderStatic: true).environmentObject(model).environmentObject(settings).frame(width: 720, height: 520).environment(\.colorScheme, .dark).background(Color(red: 0.11, green: 0.11, blue: 0.125)) }
    }

    /// Center on the ACTIVE screen — the one containing the mouse pointer.
    private static func center(_ w: NSWindow) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
        guard let vf = screen?.visibleFrame else {
            w.center()
            return
        }
        let size = w.frame.size
        w.setFrameOrigin(NSPoint(
            x: vf.midX - size.width / 2,
            y: vf.midY - size.height / 2
        ))
    }

    /// Verification aid: settings-shot.sh asserts the frame sits inside the
    /// active screen's visible frame.
    private static func logFrame(_ w: NSWindow) {
        guard let screen = w.screen ?? NSScreen.main else { return }
        let f = w.frame
        let v = screen.visibleFrame
        print(
            "settings-frame x=\(Int(f.origin.x)) y=\(Int(f.origin.y)) w=\(Int(f.width)) h=\(Int(f.height))",
            "screen x=\(Int(v.origin.x)) y=\(Int(v.origin.y)) w=\(Int(v.width)) h=\(Int(v.height))"
        )
        fflush(stdout) // the verification script tails this before the app exits
    }
}

// MARK: - Root view: sidebar + panes

struct SettingsRootView: View {
    enum Pane: String, CaseIterable {
        case general = "General"
        case menubar = "Menu bar"
        case popover = "Popover"
        case providers = "Providers"
        case notifications = "Notifications"
        case account = "Account"

        var icon: String {
            switch self {
            case .general: return "gearshape"
            case .menubar: return "menubar.rectangle"
            case .popover: return "rectangle.grid.1x2"
            case .providers: return "shippingbox"
            case .notifications: return "bell"
            case .account: return "person.crop.circle"
            }
        }
    }

    /// ImageRenderer (verification shots) can't lay out ScrollView contents —
    /// the static variant swaps it for a plain VStack.
    var renderStatic = false
    @State private var pane: Pane = {
        // Verification aid: preselect a pane for screenshots.
        if let raw = ProcessInfo.processInfo.environment["BURNBAR_SETTINGS_PANE"],
           let p = Pane.allCases.first(where: { $0.rawValue.lowercased().replacingOccurrences(of: " ", with: "") == raw.lowercased() }) {
            return p
        }
        return .general
    }()

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Pane.allCases, id: \.self) { p in
                    Button {
                        pane = p
                    } label: {
                        Label(p.rawValue, systemImage: p.icon)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                            .padding(.horizontal, 8)
                            .background(
                                pane == p ? Color.primary.opacity(0.1) : .clear,
                                in: RoundedRectangle(cornerRadius: 6)
                            )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Text("BurnBar 0.5.0").font(.caption2).foregroundStyle(.tertiary).padding(.leading, 8)
            }
            .padding(10)
            .frame(width: 170)
            .background(.quaternary.opacity(0.3))

            Divider()

            if renderStatic {
                paneContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    paneContent
                }
            }
        }
        .frame(minWidth: 720, minHeight: 520)
    }

    private var paneContent: some View {
        Group {
            switch pane {
            case .general: GeneralPane()
            case .menubar: MenuBarPane()
            case .popover: PopoverPane()
            case .providers: ProvidersPane()
            case .notifications: NotificationsPane()
            case .account: AccountPane()
            }
        }
        .toggleStyle(CheckToggleStyle())
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Panes

private struct SectionHeader: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 8)
    }
}

struct GeneralPane: View {
    @EnvironmentObject private var settings: SettingsStore
    @State private var launchAtLogin = LaunchAtLogin.isEnabled

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Startup")
            Toggle("Launch at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, on in
                    LaunchAtLogin.set(on)
                    launchAtLogin = LaunchAtLogin.isEnabled
                }

            SectionHeader("Refresh")
            HStack(spacing: 10) {
                Text("Limits polling")
                PillPicker(
                    options: [(60, "60s"), (120, "2 min"), (300, "5 min")],
                    selection: $settings.limitsRefreshSeconds
                )
            }
            Text("Burn data is real-time (file watching) — no polling needed. Limits also refresh on wake and when you open the popover.")
                .font(.caption).foregroundStyle(.secondary)

            SectionHeader("Leaderboard sync")
            Toggle("Sync my usage to whoburnedmore.com every 15 minutes", isOn: $settings.syncEnabled)
            Text("Uses your existing whoburnedmore sign-in. Off = BurnBar never sends anything anywhere; everything stays on this Mac.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct MenuBarPane: View {
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Build your own bar — three slots, any metrics")
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("First slot").font(.caption).foregroundStyle(.secondary)
                    RadioList(
                        options: MenuBarMetric.allCases.filter { $0 != .none }.map { ($0, $0.label) },
                        selection: $settings.metricSlot1
                    )
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Second slot").font(.caption).foregroundStyle(.secondary)
                    RadioList(
                        options: MenuBarMetric.allCases.map { ($0, $0.label) },
                        selection: $settings.metricSlot2
                    )
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Third slot").font(.caption).foregroundStyle(.secondary)
                    RadioList(
                        options: MenuBarMetric.allCases.map { ($0, $0.label) },
                        selection: $settings.metricSlot3
                    )
                }
            }
            MenuBarPreviewLine()
            Text("Example: \"Session %\" + \"Today's tokens\" shows 53% · 147.7M. \"Tokens this session\" counts burn observed while BurnBar runs, inside the current 5-hour window.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            SectionHeader("Coloring")
            Toggle("Tint amber/red when a limit passes the alert thresholds", isOn: $settings.tintThresholds)
            Text("Thresholds are configured in Notifications (currently \(Int(settings.warnThreshold))% / \(Int(settings.criticalThreshold))%).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct PopoverPane: View {
    @EnvironmentObject private var settings: SettingsStore

    private let providers: [(String, String)] = [
        ("tightest", "Tightest window (auto)"), ("none", "None — just the rings"),
        ("provider:claude", "Claude"), ("provider:codex", "Codex"),
        ("provider:cursor", "Cursor"), ("provider:copilot", "Copilot"), ("provider:gemini", "Gemini"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This whole panel is yours — turn any section off, pick which providers show, and choose what leads. Nothing here is fixed.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

            SectionHeader("Primary — the big ring on top")
            Picker("", selection: $settings.primaryProvider) {
                ForEach(providers, id: \.0) { Text($0.1).tag($0.0) }
            }
            .labelsHidden().frame(maxWidth: 260)
            Text("Pin one provider as a large hero ring, let it auto-follow whichever window is tightest, or drop it for a clean row of rings.")
                .font(.caption2).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)

            SectionHeader("Sections — changes apply instantly")
            Toggle("Limits (rings + per-provider detail)", isOn: $settings.showLimits)
            Toggle("↳ pace forecast lines (\"cap ~6:40 PM\")", isOn: $settings.showForecast)
                .padding(.leading, 18).disabled(!settings.showLimits)
            Toggle("↳ provider service-status dot", isOn: $settings.showStatusDot)
                .padding(.leading, 18).disabled(!settings.showLimits)
            Toggle("Burn (today / week / 14-day sparkline)", isOn: $settings.showBurn)
            Toggle("↳ day streak", isOn: $settings.showStreak)
                .padding(.leading, 18).disabled(!settings.showBurn)
            Toggle("Top tools + models", isOn: $settings.showTools)
            Toggle("whoburnedmore rank strip", isOn: $settings.showWbm)
            Toggle("↳ rival line (\"@dax is 2.1M ahead\")", isOn: $settings.showRival)
                .padding(.leading, 18).disabled(!settings.showWbm)
        }
    }
}

struct ProvidersPane: View {
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Providers — show or hide each")
            Text("Claude and Codex are on by default. Flip on any others you use.")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("Claude Code", isOn: $settings.providerClaude)
            Toggle("Codex", isOn: $settings.providerCodex)
            Toggle("Cursor", isOn: $settings.providerCursor)
            Toggle("Copilot", isOn: $settings.providerCopilot)
            Toggle("Gemini", isOn: $settings.providerGemini)
            Toggle("Cline / Roo / Continue", isOn: $settings.providerVscode)
            Toggle("Long tail (opencode, amp, kimi, …)", isOn: $settings.providerLongtail)
            Text("Turning a provider off removes its ring and detail rows from the panel. Collection keeps running locally, so re-enabling is instant and history stays complete.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct NotificationsPane: View {
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Limit alerts")
            Toggle("Alert at thresholds", isOn: $settings.notifyThresholds)
            HStack(spacing: 10) {
                Text("Warn at")
                PillPicker(
                    options: [60.0, 70, 75, 80, 85].map { ($0, "\(Int($0))%") },
                    selection: $settings.warnThreshold
                )
            }
            .disabled(!settings.notifyThresholds)
            HStack(spacing: 10) {
                Text("Critical at")
                PillPicker(
                    options: [85.0, 90, 95, 98].map { ($0, "\(Int($0))%") },
                    selection: $settings.criticalThreshold
                )
            }
            .disabled(!settings.notifyThresholds)
            Toggle("\"You're back\" when a window resets", isOn: $settings.notifyReset)
            Toggle("Shoulder tap when projected to hit the cap within 30 min", isOn: $settings.notifyForecast)

            SectionHeader("whoburnedmore")
            Toggle("Someone overtakes me on the daily board", isOn: $settings.notifyOvertaken)
            HStack(spacing: 10) {
                Toggle("Daily digest at", isOn: $settings.digestEnabled)
                PillPicker(
                    options: [18, 19, 20, 21, 22].map { ($0, "\($0):00") },
                    selection: $settings.digestHour
                )
                .disabled(!settings.digestEnabled)
            }
            Text("— \"you burned 147M today, #4\"").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct AccountPane: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("whoburnedmore.com")
            switch model.wbmState {
            case .ready(let profile):
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text("Connected as @\(profile.handle)").fontWeight(.medium)
                    if let rank = profile.rank { Text("#\(rank)").foregroundStyle(.secondary) }
                }
                HStack {
                    Button("Open my profile ↗") {
                        if let url = WbmClient.profileURL() { NSWorkspace.shared.open(url) }
                    }
                    Button("Hide from popover") { settings.showWbm = false }
                }
            case .offline(let handle):
                Label("Connected as @\(handle) — site unreachable right now", systemImage: "wifi.slash")
                    .foregroundStyle(.secondary)
            case .noAccount:
                Text("Not connected. BurnBar works fully without an account — connect to see your rank and join the public leaderboard.")
                    .foregroundStyle(.secondary)
                ConnectButton()
            }
        }
    }
}

struct ConnectButton: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var flow = DeviceFlow()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch flow.state {
            case .idle:
                Button("Connect / create account") { flow.start() }
                    .buttonStyle(.borderedProminent).tint(.orange)
            case .waiting(let code):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Approve in your browser — code ") + Text(code).bold()
                }
                Button("Cancel") { flow.cancel() }
            case .connected(let handle):
                Label("Connected as @\(handle)", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .task { await model.refreshRemote() }
            case .failed(let reason):
                Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Button("Try again") { flow.start() }
            }
        }
    }
}

/// Live preview of the composed status-item text, right inside Settings.
struct MenuBarPreviewLine: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        HStack(spacing: 6) {
            Text("Preview:").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 3) {
                Image(systemName: "flame")
                Text(model.menuBarText ?? "")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 5))
        }
        .padding(.top, 2)
    }
}

/// SMAppService wrapper (kept tiny so panes stay testable).
import ServiceManagement

enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
    static func set(_ on: Bool) {
        if on { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
    }
}
