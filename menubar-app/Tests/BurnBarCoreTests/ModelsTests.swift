import XCTest
@testable import BurnBarCore

final class ModelsTests: XCTestCase {
    func testSidecarEventParsing() {
        let snapshot = """
        {"type":"snapshot","summary":{"generatedAt":"2026-08-02T00:00:00Z","today":{"totalTokens":100,"costUSD":1.5},"week":{"totalTokens":700,"costUSD":9},"days":[{"date":"2026-08-02","tokens":100,"costUSD":1.5}],"byToolToday":[{"tool":"claude","tokens":100,"costUSD":1.5}],"byTool14d":[],"topModelsToday":[],"toolsFound":["claude"],"partial":false}}
        """
        guard case .snapshot(let s)? = SidecarEvent.parse(line: snapshot) else {
            return XCTFail("snapshot did not parse")
        }
        XCTAssertEqual(s.today.totalTokens, 100)
        XCTAssertEqual(s.byToolToday.first?.tool, "claude")

        let limits = """
        {"type":"limits","limits":{"codex":{"present":true,"capturedAt":null,"planType":"plus","limitId":"codex","primary":{"label":"session","usedPercent":62.5,"windowMinutes":300,"resetsAt":"2026-08-02T11:00:00.000Z","forecastHitAt":null},"secondary":null,"creditsBalance":null,"hasCredits":true,"unlimited":false}}}
        """
        guard case .limits(let l)? = SidecarEvent.parse(line: limits) else {
            return XCTFail("limits did not parse")
        }
        XCTAssertEqual(l.codex.primary?.usedPercent, 62.5)

        guard case .alert(let kind, let provider, let level, let percent)? =
            SidecarEvent.parse(line: #"{"type":"alert","kind":"threshold","provider":"codex","level":80,"percent":83}"#)
        else { return XCTFail("alert did not parse") }
        XCTAssertEqual([kind, provider], ["threshold", "codex"])
        XCTAssertEqual(level, 80)
        XCTAssertEqual(percent, 83)

        XCTAssertNil(SidecarEvent.parse(line: ""))
        XCTAssertNil(SidecarEvent.parse(line: "garbage {"))
        XCTAssertEqual(SidecarEvent.parse(line: #"{"type":"future-thing"}"#), .unknown)
    }

    func testClaudeUsageDecoding() {
        // Trimmed real response shape from the live endpoint (2026-08-02).
        let json = """
        {"five_hour":{"utilization":43.0,"resets_at":"2026-08-02T00:30:00.698242+00:00"},
         "seven_day":{"utilization":44.0,"resets_at":"2026-08-07T12:00:00.698261+00:00"},
         "seven_day_opus":null,
         "extra_usage":{"is_enabled":false},
         "limits":[
           {"kind":"session","group":"session","percent":43,"resets_at":"2026-08-02T00:30:00.698242+00:00","scope":null,"is_active":true},
           {"kind":"weekly_scoped","group":"weekly","percent":51,"resets_at":"2026-08-07T12:00:00.698494+00:00","scope":{"model":{"id":null,"display_name":"Fable"}}}
         ],
         "unknown_future_field":{"x":1}}
        """
        guard let usage = ClaudeUsage.decode(from: Data(json.utf8)) else {
            return XCTFail("usage did not decode")
        }
        XCTAssertEqual(usage.fiveHour?.utilization, 43.0)
        XCTAssertEqual(usage.sevenDay?.utilization, 44.0)
        XCTAssertEqual(usage.scoped.count, 2)
        XCTAssertEqual(usage.scoped.last?.modelName, "Fable")
        XCTAssertNil(ClaudeUsage.decode(from: Data("not json".utf8)))
    }

    func testWbmProfileDecoding() {
        let json = #"{"rank":12,"dailyRank":3,"weeklyRank":7,"totals":{"totalTokens":123456},"extra":true}"#
        let p = WbmProfile.decode(handle: "arhamamiin", data: Data(json.utf8))
        XCTAssertEqual(p?.rank, 12)
        XCTAssertEqual(p?.dailyRank, 3)
        XCTAssertEqual(p?.totalTokens, 123_456)
        XCTAssertNil(WbmProfile.decode(handle: "x", data: Data("[]".utf8)))
    }

    func testWbmLeaderboardDecodingAndContext() {
        let rows = (1...15).map { rank in
            """
            {"rank":\(rank),"handle":"person-\(rank)","displayName":"Person \(rank)","totalTokens":\(rank * 1_000_000),"todayTokens":\(rank == 7 ? 9_000_000 : rank * 10_000)}
            """
        }.joined(separator: ",")
        let json = "{\"period\":\"all\",\"rows\":[\(rows)],\"extra\":true}"

        let board = WbmLeaderboard.decode(data: Data(json.utf8))
        XCTAssertEqual(board?.period, "all")
        XCTAssertEqual(board?.rows.first?.displayName, "Person 1")
        XCTAssertEqual(board?.rows.first?.tokens, 1_000_000)
        XCTAssertEqual(board?.dailyLeader?.rank, 7)
        XCTAssertEqual(board?.dailyLeader?.todayTokens, 9_000_000)
        XCTAssertEqual(
            board?.context(for: "person-12").map(\.rank),
            [1, 2, 11, 12, 13]
        )
    }

    func testWbmLeaderboardContextDeduplicatesAndBackfillsNearTheTop() {
        var rows = (1...8).map {
            WbmLeaderboardEntry(rank: $0, handle: "person-\($0)", displayName: "Person \($0)", tokens: $0 * 100, todayTokens: $0)
        }
        rows.append(WbmLeaderboardEntry(rank: 4, handle: "PERSON-4", displayName: "Duplicate", tokens: 1, todayTokens: 1))
        let board = WbmLeaderboard(period: "all", rows: rows)

        let context = board.context(for: "person-4")
        XCTAssertEqual(context.map(\.rank), [1, 2, 3, 4, 5])
        XCTAssertEqual(Set(context.map { $0.handle.lowercased() }).count, context.count)
        XCTAssertEqual(context.count, 5)
    }

    func testWbmLeaderboardContextFallsBackToTopFiveWhenPersonIsMissingToday() {
        let board = WbmLeaderboard(
            period: "today",
            rows: (1...8).map {
                WbmLeaderboardEntry(rank: $0, handle: "person-\($0)", displayName: "Person \($0)", tokens: $0 * 100, todayTokens: $0)
            }
        )

        XCTAssertEqual(board.context(for: "not-listed").map(\.rank), [1, 2, 3, 4, 5])
        XCTAssertEqual(board.context(for: "person-8", maxRows: 4).map(\.rank), [1, 2, 7, 8])
    }

    func testWbmProfileCanAttachLeaderboardContextWithoutChangingProfileTotals() {
        let profile = WbmProfile(handle: "me", rank: 12, dailyRank: 4, weeklyRank: 7, totalTokens: 123_456)
        let context = [
            WbmLeaderboardEntry(rank: 1, handle: "leader", displayName: "Leader", tokens: 9_000, todayTokens: 700),
            WbmLeaderboardEntry(rank: 4, handle: "me", displayName: "Me", tokens: 4_000, todayTokens: 400),
        ]

        let enriched = profile.withLeaderboardContext(context, dailyLeader: context[0])
        XCTAssertEqual(enriched.rank, 12)
        XCTAssertEqual(enriched.dailyRank, 4)
        XCTAssertEqual(enriched.totalTokens, 123_456)
        XCTAssertEqual(enriched.leaderboardContext, context)
        XCTAssertEqual(enriched.dailyLeader, context[0])
    }

    func testAlertEdgeMirrorsSidecarSemantics() {
        var edge = AlertEdge()
        XCTAssertTrue(edge.feed(92).isEmpty) // first sample: no edge
        let up = edge.feed(96)
        XCTAssertEqual(up.count, 1) // 92→96 crosses only 95
        XCTAssertEqual(up.first?.level, 95)
        let reset = edge.feed(2)
        XCTAssertEqual(reset.first?.kind, "reset")
        let reclimb = edge.feed(85)
        XCTAssertEqual(reclimb.first?.level, 80) // re-armed after reset
        XCTAssertTrue(edge.feed(nil).isEmpty)
    }
}
