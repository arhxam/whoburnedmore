import XCTest
@testable import BurnBarCore

final class ProviderLimitTests: XCTestCase {
    private func limit(_ id: String, _ pct: Double?) -> ProviderLimit {
        ProviderLimit(id: id, name: id.capitalized, metrics: [
            ProviderMetric(id: "\(id)-h", label: "window", percent: pct),
        ])
    }

    func testHeroTightestPicksHighestPercent() {
        let limits = [limit("claude", 53), limit("codex", 71), limit("gemini", 88), limit("cursor", 61)]
        let hero = ProviderLimits.hero(from: limits, choice: .tightest)
        XCTAssertEqual(hero?.id, "gemini")
    }

    func testHeroNoneReturnsNil() {
        XCTAssertNil(ProviderLimits.hero(from: [limit("claude", 53)], choice: .none))
    }

    func testHeroPinnedProviderWins() {
        let limits = [limit("claude", 53), limit("gemini", 88)]
        XCTAssertEqual(ProviderLimits.hero(from: limits, choice: .provider("claude"))?.id, "claude")
    }

    func testHeroPinnedProviderFallsBackToTightestWhenAbsent() {
        let limits = [limit("claude", 53), limit("codex", 71)]
        // cursor not present → fall back to tightest (codex 71)
        XCTAssertEqual(ProviderLimits.hero(from: limits, choice: .provider("cursor"))?.id, "codex")
    }

    func testPrimaryChoiceRoundTrip() {
        for c in [PrimaryChoice.none, .tightest, .provider("codex")] {
            XCTAssertEqual(PrimaryChoice(rawValue: c.rawValue), c)
        }
        XCTAssertEqual(PrimaryChoice(rawValue: "garbage"), .tightest)
    }

    func testProviderLimitHeadlineAndDetailSplit() {
        let p = ProviderLimit(id: "claude", name: "Claude", metrics: [
            ProviderMetric(id: "a", label: "5h", percent: 53),
            ProviderMetric(id: "b", label: "weekly", percent: 45),
            ProviderMetric(id: "c", label: "Fable", percent: 84),
        ])
        XCTAssertEqual(p.headline?.label, "5h")
        XCTAssertEqual(p.detail.map(\.label), ["weekly", "Fable"])
        XCTAssertEqual(p.headlinePercent, 53)
        XCTAssertTrue(p.hasData)
    }

    func testProviderMetricResetCountdownIsAvailableForEveryUsageRow() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let metric = ProviderMetric(
            id: "weekly", label: "weekly", percent: 100,
            reset: now.addingTimeInterval(6 * 24 * 3600 + 7 * 3600)
        )
        XCTAssertEqual(metric.resetCountdown(from: now), "6d 7h")
        XCTAssertNil(ProviderMetric(id: "credits", label: "credits", percent: nil).resetCountdown(from: now))
    }

    @MainActor func testDefaultProvidersAreClaudeAndCodexOnly() {
        let d = UserDefaults(suiteName: "bb-defaults-\(UUID().uuidString)")!
        let s = SettingsStore(defaults: d)
        XCTAssertTrue(s.providerClaude)
        XCTAssertTrue(s.providerCodex)
        XCTAssertFalse(s.providerCursor)
        XCTAssertFalse(s.providerCopilot)
        XCTAssertFalse(s.providerGemini)
        XCTAssertFalse(s.providerVscode)
        XCTAssertFalse(s.providerLongtail)
    }

    func testDemoStackHasFiveProviders() {
        let demo = ProviderLimits.demo()
        XCTAssertEqual(demo.map(\.id), ["claude", "codex", "cursor", "copilot", "gemini"])
        // Codex demo carries a non-percent credits detail row.
        XCTAssertTrue(demo[1].metrics.contains { $0.note?.contains("left") == true })
    }
}
