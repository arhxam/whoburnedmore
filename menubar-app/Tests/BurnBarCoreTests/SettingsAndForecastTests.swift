import XCTest
@testable import BurnBarCore

final class ProviderSamplePolicyTests: XCTestCase {
    func testRetainsLastKnownGoodOnTransientAbsence() {
        XCTAssertFalse(ProviderSamplePolicy.shouldAccept(
            previousHasData: true,
            incomingHasData: false
        ))
        XCTAssertTrue(ProviderSamplePolicy.shouldAccept(
            previousHasData: false,
            incomingHasData: false
        ))
        XCTAssertTrue(ProviderSamplePolicy.shouldAccept(
            previousHasData: true,
            incomingHasData: true
        ))
        XCTAssertTrue(ProviderSamplePolicy.shouldAccept(
            previousHasData: true,
            incomingHasData: false,
            authoritativeAbsence: true
        ))
    }
}

@MainActor
final class SettingsStoreTests: XCTestCase {
    func testLeaderboardNetworkPolicyIsClosedWhenSyncIsOff() {
        XCTAssertFalse(OutboundPrivacyPolicy.allowsLeaderboardNetwork(syncEnabled: false))
        XCTAssertTrue(OutboundPrivacyPolicy.allowsLeaderboardNetwork(syncEnabled: true))
    }
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

    func testPersistedNumericPreferencesAreNormalizedToSupportedValues() {
        XCTAssertEqual(SettingsStore.normalizedRefreshSeconds(119), 120)
        XCTAssertEqual(SettingsStore.normalizedRefreshSeconds(90), 60)
        XCTAssertEqual(SettingsStore.normalizedRefreshSeconds(0), 60)
        XCTAssertEqual(SettingsStore.normalizedRefreshSeconds(-500), 60)
        XCTAssertEqual(SettingsStore.normalizedRefreshSeconds(.nan), 60)

        XCTAssertEqual(SettingsStore.normalizedWarnThreshold(73), 75)
        XCTAssertEqual(SettingsStore.normalizedWarnThreshold(72.5), 70)
        XCTAssertEqual(SettingsStore.normalizedWarnThreshold(.infinity), 80)
        XCTAssertEqual(SettingsStore.normalizedCriticalThreshold(97), 98)
        XCTAssertEqual(SettingsStore.normalizedCriticalThreshold(87.5), 85)
        XCTAssertEqual(SettingsStore.normalizedCriticalThreshold(-1), 85)
        XCTAssertEqual(SettingsStore.normalizedDigestHour(17), 18)
        XCTAssertEqual(SettingsStore.normalizedDigestHour(20.6), 21)
        XCTAssertEqual(SettingsStore.normalizedDigestHour(19.5), 19)
        XCTAssertEqual(SettingsStore.normalizedDigestHour(.nan), 21)
    }

    func testSettingsStoreLoadsOnlySafeRefreshAndNotificationValues() {
        let d = freshDefaults()
        d.set(119.0, forKey: SettingsStore.Keys.limitsRefresh)
        d.set(73.0, forKey: SettingsStore.Keys.warnThreshold)
        d.set(97.0, forKey: SettingsStore.Keys.criticalThreshold)
        d.set(20.6, forKey: SettingsStore.Keys.digestHour)

        let settings = SettingsStore(defaults: d)
        XCTAssertEqual(settings.limitsRefreshSeconds, 120)
        XCTAssertEqual(settings.warnThreshold, 75)
        XCTAssertEqual(settings.criticalThreshold, 98)
        XCTAssertEqual(settings.digestHour, 21)
    }

    func testSettingsStoreRepairsPersistedZeroNegativeAndNonFiniteValues() {
        let cases: [(Double, Int, Double, Double, Int)] = [
            (0, 60, 60, 85, 18),
            (-500, 60, 60, 85, 18),
            (.nan, 60, 80, 95, 21),
            (.infinity, 60, 80, 95, 21),
        ]
        for (stored, refresh, warn, critical, digest) in cases {
            let d = freshDefaults()
            d.set(stored, forKey: SettingsStore.Keys.limitsRefresh)
            d.set(stored, forKey: SettingsStore.Keys.warnThreshold)
            d.set(stored, forKey: SettingsStore.Keys.criticalThreshold)
            d.set(stored, forKey: SettingsStore.Keys.digestHour)

            let settings = SettingsStore(defaults: d)
            XCTAssertEqual(settings.limitsRefreshSeconds, refresh)
            XCTAssertEqual(settings.warnThreshold, warn)
            XCTAssertEqual(settings.criticalThreshold, critical)
            XCTAssertEqual(settings.digestHour, digest)
        }
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

final class LiveSyncThrottleTests: XCTestCase {
    func testStreamsChangedTotalsAtALeadingEdgeAndThenAtFixedIntervals() {
        let base = Date(timeIntervalSince1970: 1_000_000)
        var throttle = LiveSyncThrottle(minimumInterval: 30)

        throttle.observe(tokens: 100)
        XCTAssertEqual(throttle.beginIfDue(now: base), 100)

        // Continuous token events do not postpone the next upload forever: the
        // latest total is sent as soon as the fixed 30-second window expires.
        throttle.observe(tokens: 200)
        XCTAssertNil(throttle.beginIfDue(now: base.addingTimeInterval(5)))
        throttle.observe(tokens: 300)
        XCTAssertNil(throttle.beginIfDue(now: base.addingTimeInterval(29)))
        XCTAssertEqual(throttle.beginIfDue(now: base.addingTimeInterval(30)), 300)

        throttle.markSynced(tokens: 300)
        XCTAssertNil(throttle.beginIfDue(now: base.addingTimeInterval(60)))

        throttle.observe(tokens: 400)
        XCTAssertEqual(throttle.beginIfDue(now: base.addingTimeInterval(60)), 400)
    }

    func testIgnoresEmptyAndAlreadySyncedTotals() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        var throttle = LiveSyncThrottle(minimumInterval: 30)
        throttle.observe(tokens: 0)
        XCTAssertNil(throttle.beginIfDue(now: now))
        throttle.observe(tokens: 50)
        XCTAssertEqual(throttle.beginIfDue(now: now), 50)
        throttle.markSynced(tokens: 50)
        throttle.observe(tokens: 50)
        XCTAssertNil(throttle.beginIfDue(now: now.addingTimeInterval(60)))
    }
}

final class BackgroundActivityPolicyTests: XCTestCase {
    func testSyncPollingSleepsOnlyWhenTheUserEnabledLiveSync() {
        XCTAssertNil(BackgroundActivityPolicy.syncPollInterval(syncEnabled: false))
        XCTAssertEqual(BackgroundActivityPolicy.syncPollInterval(syncEnabled: true), 5)
    }

    func testEqualPublishedValuesDoNotInvalidateTheUI() {
        XCTAssertFalse(PublishedValuePolicy.shouldPublish(current: 10, incoming: 10))
        XCTAssertTrue(PublishedValuePolicy.shouldPublish(current: 10, incoming: 11))
        XCTAssertTrue(PublishedValuePolicy.shouldPublish(current: nil as Int?, incoming: 10))
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
