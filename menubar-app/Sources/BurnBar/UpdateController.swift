import BurnBarCore
import Combine
import Foundation
import Sparkle

@MainActor
final class UpdateController: ObservableObject {
    static let shared = UpdateController(startingUpdater: shouldStartUpdater)

    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var automaticallyChecksForUpdates = false
    @Published private(set) var automaticallyDownloadsUpdates = false
    @Published private(set) var allowsAutomaticUpdates = false

    private let controller: SPUStandardUpdaterController
    private var observations = Set<AnyCancellable>()

    private init(startingUpdater: Bool) {
        let controller = SPUStandardUpdaterController(
            startingUpdater: startingUpdater,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        self.controller = controller

        let updater = controller.updater
        updater.publisher(for: \SPUUpdater.canCheckForUpdates)
            .removeDuplicates()
            .sink { [weak self] value in self?.canCheckForUpdates = value }
            .store(in: &observations)
        updater.publisher(for: \SPUUpdater.automaticallyChecksForUpdates)
            .removeDuplicates()
            .sink { [weak self] value in self?.automaticallyChecksForUpdates = value }
            .store(in: &observations)
        updater.publisher(for: \SPUUpdater.automaticallyDownloadsUpdates)
            .removeDuplicates()
            .sink { [weak self] value in self?.automaticallyDownloadsUpdates = value }
            .store(in: &observations)
        updater.publisher(for: \SPUUpdater.allowsAutomaticUpdates)
            .removeDuplicates()
            .sink { [weak self] value in self?.allowsAutomaticUpdates = value }
            .store(in: &observations)
    }

    func setAutomaticallyChecksForUpdates(_ enabled: Bool) {
        var preferences = UpdatePreferences(
            automaticallyChecksForUpdates: controller.updater.automaticallyChecksForUpdates,
            automaticallyDownloadsUpdates: controller.updater.automaticallyDownloadsUpdates
        )
        preferences.setAutomaticallyChecksForUpdates(enabled)

        if !preferences.automaticallyDownloadsUpdates {
            controller.updater.automaticallyDownloadsUpdates = false
        }
        controller.updater.automaticallyChecksForUpdates = preferences.automaticallyChecksForUpdates
    }

    func setAutomaticallyDownloadsUpdates(_ enabled: Bool) {
        var preferences = UpdatePreferences(
            automaticallyChecksForUpdates: controller.updater.automaticallyChecksForUpdates,
            automaticallyDownloadsUpdates: controller.updater.automaticallyDownloadsUpdates
        )
        preferences.setAutomaticallyDownloadsUpdates(enabled)
        controller.updater.automaticallyDownloadsUpdates = preferences.automaticallyDownloadsUpdates
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    private static var shouldStartUpdater: Bool {
        let environment = ProcessInfo.processInfo.environment
        if environment["BURNBAR_DISABLE_UPDATES"] == "1" { return false }
        return environment["BURNBAR_SHOT_PATH"] == nil
            && environment["BURNBAR_ISLAND_SCREENSHOT"] == nil
            && environment["BURNBAR_SHOT_MENUBAR"] == nil
    }
}
