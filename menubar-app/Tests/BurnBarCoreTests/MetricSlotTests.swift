import XCTest
@testable import BurnBarCore

final class MetricSlotTests: XCTestCase {
    private func inputs(
        today: Int = 147_712_493,
        cost: Double = 185,
        session: Double? = 53,
        reset: Date? = Date(timeIntervalSince1970: 2_000_000 + 3600),
        sessionTokens: Int? = 8_400_000,
        weekly: Double? = 45,
        worst: Double? = 54
    ) -> MenuBarMetric.Inputs {
        let summary = Summary(
            generatedAt: "x",
            today: TotalsLine(totalTokens: today, costUSD: cost),
            week: TotalsLine(totalTokens: 0, costUSD: 0),
            days: [], byToolToday: [], byTool14d: [], topModelsToday: [],
            toolsFound: [], partial: false
        )
        return .init(
            summary: summary, worstPercent: worst, sessionPercent: session,
            sessionReset: reset, sessionTokens: sessionTokens, weeklyPercent: weekly,
            now: Date(timeIntervalSince1970: 2_000_000)
        )
    }

    func testMetricSlotEveryMetricFormats() {
        let i = inputs()
        XCTAssertEqual(MenuBarMetric.sessionPercent.text(i), "53%")
        XCTAssertEqual(MenuBarMetric.sessionCountdown.text(i), "1h 0m")
        XCTAssertEqual(MenuBarMetric.sessionTokens.text(i), "8.4M")
        XCTAssertEqual(MenuBarMetric.todayTokens.text(i), "147.7M")
        XCTAssertEqual(MenuBarMetric.todayCost.text(i), "$185")
        XCTAssertEqual(MenuBarMetric.weeklyPercent.text(i), "45%")
        XCTAssertEqual(MenuBarMetric.tightestLimit.text(i), "54%")
        XCTAssertNil(MenuBarMetric.none.text(i))
    }

    func testMetricSlotPairJoinAndCollapse() {
        let i = inputs()
        // The user's exact ask: session % next to today's tokens.
        XCTAssertEqual(MenuBarMetric.pairText(.sessionPercent, .todayTokens, i), "53% · 147.7M")
        XCTAssertEqual(MenuBarMetric.pairText(.sessionTokens, .none, i), "8.4M")
        XCTAssertEqual(MenuBarMetric.pairText(.none, .none, i), nil)
        // A nil metric value collapses instead of leaving a dangling separator.
        XCTAssertEqual(MenuBarMetric.pairText(.sessionPercent, .todayTokens, inputs(session: nil)), "147.7M")
    }

    func testMetricSlotLegacyMigration() {
        XCTAssertEqual(MenuBarMetric.migrate(from: .sessionStatus).0, .sessionPercent)
        XCTAssertEqual(MenuBarMetric.migrate(from: .sessionStatus).1, .sessionCountdown)
        XCTAssertEqual(MenuBarMetric.migrate(from: .tokensPlusLimit).0, .todayTokens)
        XCTAssertEqual(MenuBarMetric.migrate(from: .tokensPlusLimit).1, .tightestLimit)
        XCTAssertEqual(MenuBarMetric.migrate(from: .iconOnly).0, MenuBarMetric.none)
    }

    func testSettingsStoreMetricSlotRoundTripAndMigration() {
        let d = UserDefaults(suiteName: "bb-metric-test-\(UUID().uuidString)")!
        // Legacy user: only textMode stored → slots migrate.
        d.set("tokensPlusLimit", forKey: SettingsStore.Keys.textMode)
        let migratedStore = MainActor.assumeIsolated { SettingsStore(defaults: d) }
        MainActor.assumeIsolated {
            XCTAssertEqual(migratedStore.metricSlot1, .todayTokens)
            XCTAssertEqual(migratedStore.metricSlot2, .tightestLimit)
            // Explicit choice persists and wins on next load.
            migratedStore.metricSlot1 = .sessionPercent
            migratedStore.metricSlot2 = .todayTokens
        }
        let reloaded = MainActor.assumeIsolated { SettingsStore(defaults: d) }
        MainActor.assumeIsolated {
            XCTAssertEqual(reloaded.metricSlot1, .sessionPercent)
            XCTAssertEqual(reloaded.metricSlot2, .todayTokens)
        }
    }
}

final class SessionMeterTests: XCTestCase {
    func testSessionMeterAccumulatesDeltas() {
        var m = SessionMeter()
        let reset = Date().addingTimeInterval(3600)
        XCTAssertEqual(m.feed(todayTokens: 1000, windowResetAt: reset), 0) // baseline
        XCTAssertEqual(m.feed(todayTokens: 1500, windowResetAt: reset), 500)
        XCTAssertEqual(m.feed(todayTokens: 1500, windowResetAt: reset), 500) // idle
        XCTAssertEqual(m.feed(todayTokens: 4000, windowResetAt: reset), 3000)
    }

    func testSessionMeterResetsWhenWindowRolls() {
        var m = SessionMeter()
        let reset1 = Date().addingTimeInterval(1800)
        m.feed(todayTokens: 1000, windowResetAt: reset1)
        m.feed(todayTokens: 6000, windowResetAt: reset1)
        // New window: resetsAt jumps 5h forward → counter starts over.
        let reset2 = reset1.addingTimeInterval(5 * 3600)
        XCTAssertEqual(m.feed(todayTokens: 6200, windowResetAt: reset2), 200)
    }

    func testSessionMeterMidnightRollover() {
        var m = SessionMeter()
        let reset = Date().addingTimeInterval(3600)
        m.feed(todayTokens: 9_000_000, windowResetAt: reset)
        m.feed(todayTokens: 9_500_000, windowResetAt: reset) // 500k this session
        // Midnight: today's total restarts near zero mid-window.
        XCTAssertEqual(m.feed(todayTokens: 40_000, windowResetAt: reset), 540_000)
    }

    func testSessionMeterNoResetInfoStillCounts() {
        var m = SessionMeter()
        m.feed(todayTokens: 100, windowResetAt: nil)
        XCTAssertEqual(m.feed(todayTokens: 700, windowResetAt: nil), 600)
    }
}
