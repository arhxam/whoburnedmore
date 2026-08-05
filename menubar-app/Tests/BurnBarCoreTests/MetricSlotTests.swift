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

    func testMetricSlotWeeklyAndWeekMetrics() {
        var i = inputs()
        // weeklyReset defaults nil in the helper — provide one via a fresh Inputs.
        i = .init(
            summary: i.summary, worstPercent: i.worstPercent, sessionPercent: i.sessionPercent,
            sessionReset: i.sessionReset, sessionTokens: i.sessionTokens, weeklyPercent: 45,
            weeklyReset: Date(timeIntervalSince1970: 2_000_000 + 3 * 86_400 + 7_200),
            now: Date(timeIntervalSince1970: 2_000_000)
        )
        XCTAssertEqual(MenuBarMetric.weeklyReset.text(i), "3d 2h")
        XCTAssertEqual(MenuBarMetric.weeklyPercent.text(i), "45%")
        // week totals are zero in the fixture summary → formatted, not nil
        XCTAssertEqual(MenuBarMetric.weekTokens.text(i), "0")
        XCTAssertEqual(MenuBarMetric.weekCost.text(i), "$0.00")
        XCTAssertNil(MenuBarMetric.weeklyReset.text(inputs())) // no reset → collapses
    }

    func testMetricSlotTripleCombination() {
        let i = inputs()
        XCTAssertEqual(
            MenuBarMetric.slotsText([.sessionPercent, .sessionCountdown, .todayTokens], i),
            "53% · 1h 0m · 147.7M"
        )
        XCTAssertEqual(MenuBarMetric.slotsText([.todayTokens, .none, .none], i), "147.7M")
        XCTAssertNil(MenuBarMetric.slotsText([.none, .none, .none], i))
        // A nil-valued middle slot collapses cleanly.
        XCTAssertEqual(
            MenuBarMetric.slotsText([.sessionPercent, .weeklyReset, .todayCost], i),
            "53% · $185"
        )
    }

    func testFreshInstallDefaultTrio() {
        // A fresh install (no legacy textMode) ships the default bar:
        // today's tokens · session % · session resets-in, all "all"-scoped.
        let d = UserDefaults(suiteName: "bb-fresh-\(UUID().uuidString)")!
        let store = MainActor.assumeIsolated { SettingsStore(defaults: d) }
        MainActor.assumeIsolated {
            XCTAssertEqual(store.metricSlot1, .todayTokens)
            XCTAssertEqual(store.metricSlot2, .sessionPercent)
            XCTAssertEqual(store.metricSlot3, .sessionCountdown)
            XCTAssertEqual(store.metricProvider1, "all")
            XCTAssertEqual(store.metricProvider2, "all")
            XCTAssertEqual(store.metricProvider3, "all")
        }
    }

    func testMetricSlotProviderRoundTrip() {
        let d = UserDefaults(suiteName: "bb-slotprov-\(UUID().uuidString)")!
        let store = MainActor.assumeIsolated { SettingsStore(defaults: d) }
        MainActor.assumeIsolated {
            store.metricSlot3 = .weeklyReset
            store.metricProvider2 = "codex"
        }
        let reloaded = MainActor.assumeIsolated { SettingsStore(defaults: d) }
        MainActor.assumeIsolated {
            XCTAssertEqual(reloaded.metricSlot3, .weeklyReset)
            XCTAssertEqual(reloaded.metricProvider2, "codex")
        }
    }

    func testProviderScopedSlotsTagAndResolve() {
        let base = inputs()
        let codex = MenuBarMetric.ProviderStats(
            sessionPercent: 71, sessionReset: Date(timeIntervalSince1970: 2_000_000 + 7200),
            todayTokens: 98_600_000
        )
        let claude = MenuBarMetric.ProviderStats(sessionPercent: 40, todayTokens: 12_300_000)
        let i = MenuBarMetric.Inputs(
            summary: base.summary, worstPercent: base.worstPercent,
            sessionPercent: base.sessionPercent, sessionReset: base.sessionReset,
            sessionTokens: base.sessionTokens, weeklyPercent: base.weeklyPercent,
            byProvider: ["codex": codex, "claude": claude],
            now: Date(timeIntervalSince1970: 2_000_000)
        )
        // "all" tokens are bare; each scoped provider tags its OWN value.
        XCTAssertEqual(
            MenuBarMetric.slotsText([(.todayTokens, "all"), (.sessionPercent, "claude"), (.sessionPercent, "codex")], i),
            "147.7M · C 40% · X 71%"
        )
        // Codex today's tokens resolve from its own breakdown, tagged.
        XCTAssertEqual(MenuBarMetric.slotsText([(.todayTokens, "codex")], i), "X 98.6M")
        // A provider with no stats for the metric collapses.
        XCTAssertNil(MenuBarMetric.slotsText([(.weeklyPercent, "codex")], i))
        // A slot scoped to a provider with NO data at all collapses — it must NOT
        // fall back to the aggregate tagged with that provider's letter.
        XCTAssertNil(MenuBarMetric.slotsText([(.sessionPercent, "cursor")], i))
        XCTAssertEqual(
            MenuBarMetric.slotsText([(.todayTokens, "all"), (.sessionPercent, "cursor")], i),
            "147.7M"
        )
        // Global metric ignores the provider tag.
        XCTAssertEqual(MenuBarMetric.slotsText([(.tightestLimit, "codex")], i), "54%")
    }

    func testCompactTokensUnitBoundaryPromotion() {
        // Rounding must not produce "1000M"/"1000K"; it promotes to the next unit.
        XCTAssertEqual(Formatters.compactTokens(999_950_000), "1B")
        XCTAssertEqual(Formatters.compactTokens(999_950), "1M")
        XCTAssertEqual(Formatters.compactTokens(999_500), "999.5K") // stays K (doesn't round up to 1000K)
        XCTAssertEqual(Formatters.compactTokens(950_000_000), "950M") // no false promotion
        XCTAssertFalse(Formatters.compactTokens(Int.min).isEmpty) // must not crash (abs(Int.min) traps)
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
