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
    private let onToggle: () -> Void
    private var observations = Set<AnyCancellable>()

    init(model: AppModel, settings: SettingsStore, onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        hostingView = ClickThroughHostingView(
            rootView: AnyView(
                BurnBarStatusLabel()
                    .environmentObject(model)
                    .environmentObject(settings)
            )
        )
        super.init()

        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(toggleIsland)
        button.sendAction(on: [.leftMouseUp])
        button.toolTip = "Open BurnBar Island"

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
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    @objc private func toggleIsland() {
        onToggle()
    }

    private func scheduleLengthRefresh() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let width = max(28, self.hostingView.fittingSize.width + 8)
            self.statusItem.length = width
        }
    }
}

private final class ClickThroughHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct BurnBarStatusLabel: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        MenuBarLabel(text: model.menuBarText, state: model.meterState)
    }
}
