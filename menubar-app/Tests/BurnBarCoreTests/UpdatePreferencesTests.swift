import XCTest
@testable import BurnBarCore

final class UpdatePreferencesTests: XCTestCase {
    func testRecommendedDefaultsCheckDailyWithoutUnattendedInstallation() {
        let preferences = UpdatePreferences.recommendedDefaults

        XCTAssertTrue(preferences.automaticallyChecksForUpdates)
        XCTAssertFalse(preferences.automaticallyDownloadsUpdates)
        XCTAssertEqual(preferences.checkInterval, 86_400)
    }

    func testDisablingChecksAlsoDisablesAutomaticDownloads() {
        var preferences = UpdatePreferences(
            automaticallyChecksForUpdates: true,
            automaticallyDownloadsUpdates: true
        )

        preferences.setAutomaticallyChecksForUpdates(false)

        XCTAssertFalse(preferences.automaticallyChecksForUpdates)
        XCTAssertFalse(preferences.automaticallyDownloadsUpdates)
    }

    func testAutomaticDownloadsCannotBeEnabledWhileChecksAreDisabled() {
        var preferences = UpdatePreferences(
            automaticallyChecksForUpdates: false,
            automaticallyDownloadsUpdates: false
        )

        preferences.setAutomaticallyDownloadsUpdates(true)

        XCTAssertFalse(preferences.automaticallyDownloadsUpdates)
    }

    func testBundleVersionPresentationIncludesMarketingAndBuild() {
        XCTAssertEqual(
            BundleVersionPresentation(marketingVersion: "0.8.0", buildVersion: "8000").displayName,
            "BurnBar 0.8.0 (8000)"
        )
    }

    func testBundleVersionPresentationFallsBackToMarketingVersion() {
        XCTAssertEqual(
            BundleVersionPresentation(marketingVersion: "0.8.0", buildVersion: nil).displayName,
            "BurnBar 0.8.0"
        )
    }

    func testBundleVersionPresentationHandlesMissingBundleMetadata() {
        XCTAssertEqual(
            BundleVersionPresentation(marketingVersion: nil, buildVersion: nil).displayName,
            "BurnBar"
        )
    }
}
