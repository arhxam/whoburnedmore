import XCTest
@testable import BurnBarCore

@MainActor
final class SettingsStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let name = "burnbar-test-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func testSettingsStoreDefaults() {
        let s = SettingsStore(defaults: freshDefaults())
        XCTAssertEqual(s.textMode, .sessionStatus) // new default
        XCTAssertTrue(s.showLimits && s.showBurn && s.showTools && s.showSessions && s.showWbm)
        XCTAssertEqual(s.warnThreshold, 80)
        XCTAssertEqual(s.criticalThreshold, 95)
        XCTAssertFalse(s.syncEnabled)
        XCTAssertFalse(s.onboardingDone)
        XCTAssertFalse(s.claudeLimitsEnabled)
        XCTAssertFalse(s.notificationsEnabled)
        XCTAssertEqual(s.limitsRefreshSeconds, 60)
    }

    func testCompletedUsersKeepExistingPermissionBehaviorDuringMigration() {
        let d = freshDefaults()
        d.set(true, forKey: SettingsStore.Keys.onboardingDone)
        let s = SettingsStore(defaults: d)
        XCTAssertTrue(s.claudeLimitsEnabled)
        XCTAssertTrue(s.notificationsEnabled)
    }

    func testSettingsStoreRoundTrip() {
        let d = freshDefaults()
        let s1 = SettingsStore(defaults: d)
        s1.textMode = .tokensPlusLimit
        s1.showTools = false
        s1.showSessions = false
        s1.warnThreshold = 70
        s1.criticalThreshold = 90
        s1.notifyOvertaken = true
        s1.digestEnabled = true
        s1.digestHour = 19
        s1.syncEnabled = true
        s1.providerCursor = false
        s1.claudeLimitsEnabled = true
        s1.notificationsEnabled = true
        s1.onboardingDone = true

        // A brand-new store over the same defaults must read everything back.
        let s2 = SettingsStore(defaults: d)
        XCTAssertEqual(s2.textMode, .tokensPlusLimit)
        XCTAssertFalse(s2.showTools)
        XCTAssertFalse(s2.showSessions)
        XCTAssertEqual(s2.warnThreshold, 70)
        XCTAssertEqual(s2.criticalThreshold, 90)
        XCTAssertTrue(s2.notifyOvertaken)
        XCTAssertTrue(s2.digestEnabled)
        XCTAssertEqual(s2.digestHour, 19)
        XCTAssertTrue(s2.syncEnabled)
        XCTAssertFalse(s2.providerCursor)
        XCTAssertTrue(s2.claudeLimitsEnabled)
        XCTAssertTrue(s2.notificationsEnabled)
        XCTAssertTrue(s2.onboardingDone)
    }

    func testSettingsStoreProviderFilter() {
        let s = SettingsStore(defaults: freshDefaults())
        XCTAssertTrue(s.providerEnabled("claude")) // claude on by default
        XCTAssertTrue(s.providerEnabled("codex")) // codex on by default
        XCTAssertFalse(s.providerEnabled("cline")) // vscode off by default now
        XCTAssertFalse(s.providerEnabled("gemini")) // long tail off by default now
        s.providerVscode = true
        XCTAssertTrue(s.providerEnabled("roo"))
    }
}

final class ForecastTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_000_000)

    func testForecastLinearProjection() {
        // 40% -> 50% over 10 min = 1%/min; 50 points left => 50 min out.
        let hit = Forecast.limitHit(
            samples: [
                PercentSample(at: base.addingTimeInterval(-600), percent: 40),
                PercentSample(at: base, percent: 50),
            ],
            now: base
        )
        XCTAssertEqual(hit, base.addingTimeInterval(50 * 60))
    }

    func testForecastNilOnFlatDecliningOrSparse() {
        XCTAssertNil(Forecast.limitHit(samples: [PercentSample(at: base, percent: 50)], now: base))
        XCTAssertNil(Forecast.limitHit(
            samples: [
                PercentSample(at: base.addingTimeInterval(-60), percent: 50),
                PercentSample(at: base, percent: 50),
            ],
            now: base
        ))
        XCTAssertNil(Forecast.limitHit(
            samples: [
                PercentSample(at: base.addingTimeInterval(-60), percent: 50),
                PercentSample(at: base, percent: 10),
            ],
            now: base
        ))
    }

    func testConfigurableThresholdEdges() {
        var edge = ConfigurableAlertEdge(thresholds: [70, 90])
        XCTAssertTrue(edge.feed(60).isEmpty) // first sample, no edge
        let first = edge.feed(75)
        XCTAssertEqual(first.first?.level, 70) // custom threshold honored
        XCTAssertTrue(edge.feed(80).isEmpty)
        XCTAssertEqual(edge.feed(93).first?.level, 90)
        XCTAssertEqual(edge.feed(5).first?.kind, "reset")
        XCTAssertEqual(edge.feed(71).first?.level, 70) // re-armed after reset
    }

    func testForecastAlarmFiresOnceWithinLeadTime() {
        var alarm = ForecastAlarm(leadTime: 1800)
        // Hit projected 3h out — silent.
        XCTAssertFalse(alarm.feed(forecastHit: base.addingTimeInterval(3 * 3600), percent: 82, now: base))
        // Hit projected 20 min out — fires once.
        XCTAssertTrue(alarm.feed(forecastHit: base.addingTimeInterval(1200), percent: 88, now: base))
        XCTAssertFalse(alarm.feed(forecastHit: base.addingTimeInterval(1100), percent: 89, now: base))
        // Window rolls over (percent drops below 50) — re-arms.
        XCTAssertFalse(alarm.feed(forecastHit: nil, percent: 3, now: base))
        XCTAssertTrue(alarm.feed(forecastHit: base.addingTimeInterval(900), percent: 85, now: base))
    }
}

final class StatusPageTests: XCTestCase {
    func testStatusPageDecode() {
        let healthy = #"{"page":{"id":"x"},"status":{"indicator":"none","description":"All Systems Operational"}}"#
        let s = StatusPageState.decode(from: Data(healthy.utf8))
        XCTAssertEqual(s?.indicator, "none")
        XCTAssertEqual(s?.severity, "green")
        XCTAssertTrue(s?.isHealthy ?? false)

        let outage = #"{"status":{"indicator":"major","description":"Elevated errors"}}"#
        XCTAssertEqual(StatusPageState.decode(from: Data(outage.utf8))?.severity, "red")
        XCTAssertEqual(
            StatusPageState.decode(from: Data(#"{"status":{"indicator":"minor"}}"#.utf8))?.severity,
            "yellow"
        )
        XCTAssertNil(StatusPageState.decode(from: Data("garbage".utf8)))
    }
}

final class MenuBarModeV2Tests: XCTestCase {
    private var summary: Summary {
        Summary(
            generatedAt: "2026-08-02T00:00:00Z",
            today: TotalsLine(totalTokens: 147_700_000, costUSD: 185),
            week: TotalsLine(totalTokens: 2_900_000_000, costUSD: 2412),
            days: [], byToolToday: [], byTool14d: [], topModelsToday: [],
            toolsFound: ["claude"], partial: false,
            sessionsToday: [SessionToday(name: "acme-web", tool: "claude", tokens: 96_000_000)]
        )
    }

    func testSessionStatusMode() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let reset = now.addingTimeInterval(3 * 3600 + 28 * 60)
        let text = MenuBarTextMode.sessionStatus.text(.init(
            summary: summary, worstPercent: 54, sessionPercent: 53, sessionReset: reset, now: now
        ))
        XCTAssertEqual(text, "53% · 3h 28m")
    }

    func testSessionStatusFallbacks() {
        // No session data -> worst limit -> tokens -> nil.
        XCTAssertEqual(
            MenuBarTextMode.sessionStatus.text(.init(summary: summary, worstPercent: 61)),
            "61%"
        )
        XCTAssertEqual(
            MenuBarTextMode.sessionStatus.text(.init(summary: summary, worstPercent: nil)),
            "147.7M"
        )
        XCTAssertNil(MenuBarTextMode.sessionStatus.text(.init(summary: nil, worstPercent: nil)))
    }

    func testTokensPlusLimitMode() {
        XCTAssertEqual(
            MenuBarTextMode.tokensPlusLimit.text(.init(summary: summary, worstPercent: 53.4)),
            "147.7M · 53%"
        )
        XCTAssertEqual(
            MenuBarTextMode.tokensPlusLimit.text(.init(summary: summary, worstPercent: nil)),
            "147.7M"
        )
    }

    func testSummaryDecodesSessionsTodayAndCursorLimits() {
        let json = """
        {"generatedAt":"2026-08-02T00:00:00Z","today":{"totalTokens":1,"costUSD":0},
         "week":{"totalTokens":1,"costUSD":0},"days":[],"byToolToday":[],"byTool14d":[],
         "topModelsToday":[],"toolsFound":[],"partial":false,
         "sessionsToday":[{"name":"proj-a","tool":"claude","tokens":42}]}
        """
        let s = try? JSONDecoder().decode(Summary.self, from: Data(json.utf8))
        XCTAssertEqual(s?.sessionsToday?.first?.name, "proj-a")

        let lim = """
        {"codex":{"present":false,"capturedAt":null,"planType":null,"limitId":null,
         "primary":null,"secondary":null,"creditsBalance":null,"hasCredits":null,"unlimited":null},
         "cursor":{"present":true,"planPercent":31,"used":155,"limit":500,"renewsAt":"2026-08-14T00:00:00Z"}}
        """
        let l = try? JSONDecoder().decode(Limits.self, from: Data(lim.utf8))
        XCTAssertEqual(l?.cursor?.planPercent, 31)
        // Old sidecar without cursor still decodes.
        let old = """
        {"codex":{"present":false,"capturedAt":null,"planType":null,"limitId":null,
         "primary":null,"secondary":null,"creditsBalance":null,"hasCredits":null,"unlimited":null}}
        """
        XCTAssertNotNil(try? JSONDecoder().decode(Limits.self, from: Data(old.utf8)))
    }
}
