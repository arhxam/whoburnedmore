import XCTest
@testable import BurnBarCore

final class FormattersTests: XCTestCase {
    func testCompactTokens() {
        XCTAssertEqual(Formatters.compactTokens(0), "0")
        XCTAssertEqual(Formatters.compactTokens(999), "999")
        XCTAssertEqual(Formatters.compactTokens(1_234), "1.2K")
        XCTAssertEqual(Formatters.compactTokens(2_000), "2K")
        XCTAssertEqual(Formatters.compactTokens(3_400_000), "3.4M")
        XCTAssertEqual(Formatters.compactTokens(114_130_920), "114.1M")
        XCTAssertEqual(Formatters.compactTokens(2_864_722_751), "2.9B")
        XCTAssertEqual(Formatters.compactTokens(-1_500), "-1.5K")
    }

    func testUSD() {
        XCTAssertEqual(Formatters.usd(1.5), "$1.50")
        XCTAssertEqual(Formatters.usd(140.52), "$141")
        XCTAssertEqual(Formatters.usd(0), "$0.00")
    }

    func testCountdown() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(Formatters.countdown(to: now.addingTimeInterval(38), from: now), "38s")
        XCTAssertEqual(Formatters.countdown(to: now.addingTimeInterval(14 * 60), from: now), "14m")
        XCTAssertEqual(Formatters.countdown(to: now.addingTimeInterval(2 * 3600 + 14 * 60), from: now), "2h 14m")
        XCTAssertEqual(Formatters.countdown(to: now.addingTimeInterval(26 * 3600), from: now), "1d 2h")
        XCTAssertEqual(Formatters.countdown(to: now.addingTimeInterval(-5), from: now), "now")
        XCTAssertEqual(Formatters.countdown(to: nil, from: now), "—")
    }

    func testExpiredProviderWindowStopsShowingStalePressureAndReset() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(
            Formatters.effectiveLimitPercent(100, resetAt: now.addingTimeInterval(1), now: now),
            100
        )
        XCTAssertEqual(
            Formatters.effectiveLimitPercent(100, resetAt: now.addingTimeInterval(-1), now: now),
            0
        )
        XCTAssertEqual(Formatters.effectiveLimitPercent(nil, resetAt: now.addingTimeInterval(-1), now: now), nil)
        XCTAssertNotNil(Formatters.futureReset(now.addingTimeInterval(1), now: now))
        XCTAssertNil(Formatters.futureReset(now, now: now))
        XCTAssertNil(Formatters.futureReset(nil, now: now))
    }

    func testParseISOBothForms() {
        // The usage endpoint mixes fractional and plain ISO8601.
        XCTAssertNotNil(Formatters.parseISO("2026-08-02T00:30:00.698242+00:00"))
        XCTAssertNotNil(Formatters.parseISO("2026-08-08T00:00:00Z"))
        XCTAssertNil(Formatters.parseISO("not a date"))
        XCTAssertNil(Formatters.parseISO(nil))
    }

    func testMeterState() {
        XCTAssertEqual(MeterState(percent: nil), .normal)
        XCTAssertEqual(MeterState(percent: 0), .normal)
        XCTAssertEqual(MeterState(percent: 79.9), .normal)
        XCTAssertEqual(MeterState(percent: 80), .amber)
        XCTAssertEqual(MeterState(percent: 94.9), .amber)
        XCTAssertEqual(MeterState(percent: 95), .critical)
        XCTAssertEqual(MeterState(percent: 120), .critical)
        XCTAssertEqual(MeterState.worst(of: [nil, 40, 85]), .amber)
        XCTAssertEqual(MeterState.worst(of: []), .normal)
    }

    func testPercentFormattingClampsPresentation() {
        XCTAssertEqual(Formatters.percent(141), "100%")
        XCTAssertEqual(Formatters.percent(-12), "0%")
        XCTAssertNil(Formatters.percent(nil))
        XCTAssertNil(Formatters.percent(.infinity))
    }

    func testMenuBarTextModes() {
        let summary = Summary(
            generatedAt: "2026-08-02T00:00:00Z",
            today: TotalsLine(totalTokens: 114_130_920, costUSD: 140.52),
            week: TotalsLine(totalTokens: 2_864_722_751, costUSD: 2366.78),
            days: [], byToolToday: [], byTool14d: [], topModelsToday: [],
            toolsFound: ["claude"], partial: false
        )
        XCTAssertEqual(MenuBarTextMode.todayTokens.text(summary: summary, worstPercent: 43), "114.1M")
        XCTAssertEqual(MenuBarTextMode.limitPercent.text(summary: summary, worstPercent: 43.4), "43%")
        XCTAssertEqual(MenuBarTextMode.todayCost.text(summary: summary, worstPercent: nil), "$141")
        XCTAssertNil(MenuBarTextMode.iconOnly.text(summary: summary, worstPercent: 43))
        XCTAssertNil(MenuBarTextMode.todayTokens.text(summary: nil, worstPercent: nil))
        XCTAssertNil(MenuBarTextMode.limitPercent.text(summary: summary, worstPercent: nil))
    }
}
