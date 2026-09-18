import AppKit
import BurnBarCore
import Combine
import SwiftUI

/// AppKit owns the click so selecting any BurnBar metric opens the same island
/// instead of first presenting a separate SwiftUI `MenuBarExtra` window.
@MainActor
final class StatusItemController: NSObject {
    private let statusItem: NSStatusItem
    private let hostingView: ClickThroughHostingView<AnyView>
    private let model: AppModel
    private let onToggle: () -> Void
    private var observations = Set<AnyCancellable>()
    private var refreshPending = false
    private var lastText: String?
    private var lastState: MeterState?

    init(model: AppModel, settings: SettingsStore, onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
        self.model = model
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        hostingView = ClickThroughHostingView(
            rootView: AnyView(
                MenuBarLabel(text: model.menuBarText, state: model.meterState)
            )
        )
        super.init()

        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(toggleIsland)
        button.sendAction(on: [.leftMouseUp])
        button.toolTip = "Open whoburnedmore"

        hostingView.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 4),
            hostingView.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -4),
            hostingView.topAnchor.constraint(equalTo: button.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: button.bottomAnchor),
        ])

        model.objectWillChange
            .merge(with: settings.objectWillChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.scheduleLengthRefresh() }
            .store(in: &observations)
        scheduleLengthRefresh()
    }

    func remove() {
        observations.removeAll()
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    @objc private func toggleIsland() {
        onToggle()
    }

    private func scheduleLengthRefresh() {
        guard !refreshPending else { return }
        refreshPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshPending = false
            let text = self.model.menuBarText
            let state = self.model.meterState
            guard text != self.lastText || state != self.lastState else { return }
            self.lastText = text
            self.lastState = state
            self.hostingView.rootView = AnyView(MenuBarLabel(text: text, state: state))
            // Lay out only when visible content changes, after SwiftUI has
            // received the new value. Unrelated leaderboard/heartbeat updates
            // no longer remeasure or redraw the system menu bar.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let width = max(28, self.hostingView.fittingSize.width + 8)
                if self.statusItem.length != width { self.statusItem.length = width }
            }
        }
    }
}

private final class ClickThroughHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
