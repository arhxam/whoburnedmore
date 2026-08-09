import AppKit
import BurnBarCore
import Foundation
import os

@MainActor
final class AppModel: ObservableObject {
    enum LeaderboardSyncState: Equatable {
        case off
        case waiting
        case syncing
        case synced(Date)
        case failed(String)
    }

    private let log = Logger(subsystem: "com.whoburnedmore.burnbar", category: "model")

    @Published var summary: Summary?
    /// Tokens observed burning within the current 5h window (SessionMeter).
    @Published var sessionTokens: Int = 0
    private var sessionMeter = SessionMeter()
    @Published var codexLimits: CodexLimits?
    @Published var cursorLimits: CursorLimits?
    @Published var claudeState: ClaudeUsageState = .unavailable(reason: "starting…")
    @Published var claudeForecastHit: Date?
    @Published var wbmState: WbmState = .noAccount
    @Published var leaderboardSyncState: LeaderboardSyncState
    @Published var anthropicStatus: StatusPageState?
    @Published var openaiStatus: StatusPageState?
    @Published var streakDays: Int = 0
    @Published var collecting = false
    @Published var lastUpdatedAt: Date?

    let settings: SettingsStore

    private let sidecar = SidecarClient()
    private let claude = ClaudeUsageClient()
    private let wbm = WbmClient()
    private let notifier = Notifier()
    private var claudeEdge = ConfigurableAlertEdge()
    private var claudeSamples: [PercentSample] = []
    private var forecastAlarm = ForecastAlarm()
    private var prevDailyRank: Int?
    private var pollTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var digestTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    /// Upload at most twice a minute while local totals keep changing. This is
    /// a fixed-window throttle, so a long agent turn cannot defer the website
    /// update until the turn ends.
    private var liveSyncThrottle = LiveSyncThrottle(minimumInterval: 30)
    private var wakeObserver: NSObjectProtocol?
    private var started = false

    init(settings: SettingsStore) {
        self.settings = settings
        leaderboardSyncState = settings.syncEnabled ? .waiting : .off
    }

    // MARK: derived state

    /// The tightest window across ENABLED providers.
    var worstPercent: Double? {
        var percents: [Double] = []
        if settings.providerClaude, case .ready(let usage) = claudeState {
            if let window = usage.fiveHour,
               let p = Self.effectiveWindow(window.utilization, window.resetsAt).percent { percents.append(p) }
            if let window = usage.sevenDay,
               let p = Self.effectiveWindow(window.utilization, window.resetsAt).percent { percents.append(p) }
            // Only the scoped limits the popover actually surfaces — otherwise the
            // menu bar could tint red for a limit the user can't see anywhere.
            percents.append(contentsOf: usage.scoped
                .filter { $0.kind == "weekly_scoped" && $0.modelName != nil }
                .compactMap { Self.effectiveWindow($0.percent, $0.resetsAt).percent })
        }
        if settings.providerCodex, let c = codexLimits {
            if let window = c.primary,
               let p = Self.effectiveWindow(window.usedPercent, window.resetsAt).percent { percents.append(p) }
            if let window = c.secondary,
               let p = Self.effectiveWindow(window.usedPercent, window.resetsAt).percent { percents.append(p) }
        }
        if settings.providerCursor, let cursor = cursorLimits,
           let p = Self.effectiveWindow(cursor.planPercent, cursor.renewsAt).percent { percents.append(p) }
        return percents.max()
    }

    var sessionPercent: Double? {
        guard case .ready(let usage) = claudeState else { return nil }
        guard let window = usage.fiveHour else { return nil }
        return Self.effectiveWindow(window.utilization, window.resetsAt).percent
    }

    var sessionReset: Date? {
        guard case .ready(let usage) = claudeState else { return nil }
        guard let window = usage.fiveHour else { return nil }
        return Self.effectiveWindow(window.utilization, window.resetsAt).reset
    }

    var meterState: MeterState {
        guard settings.tintThresholds else { return .normal }
        guard let p = worstPercent else { return .normal }
        if p >= settings.criticalThreshold { return .critical }
        if p >= settings.warnThreshold { return .amber }
        return .normal
    }

    var weeklyPercent: Double? {
        guard case .ready(let usage) = claudeState else { return nil }
        guard let window = usage.sevenDay else { return nil }
        return Self.effectiveWindow(window.utilization, window.resetsAt).percent
    }

    var weeklyReset: Date? {
        guard case .ready(let usage) = claudeState else { return nil }
        guard let window = usage.sevenDay else { return nil }
        return Self.effectiveWindow(window.utilization, window.resetsAt).reset
    }

    private static func effectiveWindow(
        _ percent: Double?, _ resetAt: String?, now: Date = Date()
    ) -> (percent: Double?, reset: Date?) {
        let reset = Formatters.parseISO(resetAt)
        return (
            Formatters.effectiveLimitPercent(percent, resetAt: reset, now: now),
            Formatters.futureReset(reset, now: now)
        )
    }

    /// Whether to inject the full 5-provider demo stack (screenshots / preview).
    private let demoLimits = ProcessInfo.processInfo.environment["BURNBAR_DEMO_LIMITS"] == "1"

    /// Unified per-provider limits for the popover rings + detail rows, filtered
    /// by the Settings provider toggles. Each provider contributes ITS metrics
    /// (Claude: 5h + weekly + per-model; Codex: 5h + weekly + credits; …).
    var providerLimits: [ProviderLimit] {
        if demoLimits {
            return ProviderLimits.demo().filter { providerLimitEnabled($0.id) }
        }
        var out: [ProviderLimit] = []

        if settings.providerClaude, case .ready(let usage) = claudeState {
            var m: [ProviderMetric] = []
            if let fh = usage.fiveHour {
                let window = Self.effectiveWindow(fh.utilization, fh.resetsAt)
                m.append(.init(id: "c5", label: "5h window", percent: window.percent,
                               reset: window.reset, forecast: claudeForecastHit))
            }
            if let wk = usage.sevenDay {
                let window = Self.effectiveWindow(wk.utilization, wk.resetsAt)
                m.append(.init(id: "cw", label: "weekly", percent: window.percent,
                               reset: window.reset))
            }
            for s in usage.scoped where s.kind == "weekly_scoped" && s.modelName != nil {
                let window = Self.effectiveWindow(s.percent, s.resetsAt)
                m.append(.init(id: "cs-\(s.modelName!)", label: "\(s.modelName!) weekly",
                               percent: window.percent, reset: window.reset))
            }
            if !m.isEmpty { out.append(.init(id: "claude", name: "Claude", metrics: m)) }
        }

        if settings.providerCodex, let codex = codexLimits, codex.present {
            var m: [ProviderMetric] = []
            if let p = codex.primary {
                let window = Self.effectiveWindow(p.usedPercent, p.resetsAt)
                m.append(.init(id: "x-p", label: p.label, percent: window.percent,
                               reset: window.reset,
                               forecast: Formatters.parseISO(p.forecastHitAt)))
            }
            if let s = codex.secondary {
                let window = Self.effectiveWindow(s.usedPercent, s.resetsAt)
                m.append(.init(id: "x-s", label: s.label, percent: window.percent,
                               reset: window.reset))
            }
            if let bal = codex.creditsBalance {
                m.append(.init(id: "x-c", label: "credits", percent: nil, note: "\(bal) left"))
            }
            if m.isEmpty {
                m.append(.init(id: "x-plan", label: codex.planType ?? "active",
                               percent: nil, note: "no window pressure"))
            }
            out.append(.init(id: "codex", name: "Codex", metrics: m))
        }

        if settings.providerCursor, let cursor = cursorLimits, cursor.present {
            let window = Self.effectiveWindow(cursor.planPercent, cursor.renewsAt)
            out.append(.init(id: "cursor", name: "Cursor", metrics: [
                .init(id: "u", label: "plan usage", percent: window.percent,
                      reset: window.reset),
            ]))
        }

        // Token-only providers: any ENABLED tool we saw burn from today that has
        // no live limit window (Cline/Roo/Continue, Gemini, Copilot, the long
        // tail — and Claude/Codex too if their limits aren't wired) still gets a
        // row, so flipping its toggle on visibly adds it to the panel.
        let already = Set(out.map(\.id))
        for tool in summary?.byToolToday ?? [] where tool.tokens > 0 {
            let id = tool.tool.lowercased()
            guard !already.contains(id), settings.providerEnabled(id) else { continue }
            out.append(.init(id: id, name: Self.prettyProvider(id), metrics: [
                .init(id: "\(id)-tok", label: "today", percent: nil,
                      note: Formatters.compactTokens(tool.tokens)),
            ]))
        }
        return out
    }

    /// Display name for a tool id ("cline" → "Cline", "opencode" → "opencode").
    static func prettyProvider(_ id: String) -> String {
        switch id {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "cursor": return "Cursor"
        case "copilot": return "Copilot"
        case "gemini": return "Gemini"
        case "cline": return "Cline"
        case "roo": return "Roo"
        case "continue": return "Continue"
        default: return id
        }
    }

    /// Per-provider numbers for provider-scoped menu-bar slots.
    var byProviderStats: [String: MenuBarMetric.ProviderStats] {
        var out: [String: MenuBarMetric.ProviderStats] = [:]
        for t in summary?.byToolToday ?? [] {
            var s = out[t.tool.lowercased()] ?? .init()
            s.todayTokens = t.tokens
            s.todayCost = t.costUSD
            out[t.tool.lowercased()] = s
        }
        if case .ready(let u) = claudeState {
            var s = out["claude"] ?? .init()
            if let fiveHour = u.fiveHour {
                let window = Self.effectiveWindow(fiveHour.utilization, fiveHour.resetsAt)
                s.sessionPercent = window.percent
                s.sessionReset = window.reset
            }
            if let sevenDay = u.sevenDay {
                let window = Self.effectiveWindow(sevenDay.utilization, sevenDay.resetsAt)
                s.weeklyPercent = window.percent
                s.weeklyReset = window.reset
            }
            s.sessionTokens = sessionTokens
            out["claude"] = s
        }
        if let c = codexLimits, c.present {
            var s = out["codex"] ?? .init()
            if let primary = c.primary {
                let window = Self.effectiveWindow(primary.usedPercent, primary.resetsAt)
                s.sessionPercent = window.percent
                s.sessionReset = window.reset
            }
            if let secondary = c.secondary {
                let window = Self.effectiveWindow(secondary.usedPercent, secondary.resetsAt)
                s.weeklyPercent = window.percent
                s.weeklyReset = window.reset
            }
            s.creditsRemaining = c.creditsBalance
            out["codex"] = s
        }
        if let cu = cursorLimits, cu.present {
            var s = out["cursor"] ?? .init()
            let window = Self.effectiveWindow(cu.planPercent, cu.renewsAt)
            s.sessionPercent = window.percent
            s.sessionReset = window.reset
            out["cursor"] = s
        }
        return out
    }

    /// The optional hero provider (Settings → Menu bar → Primary).
    var heroProvider: ProviderLimit? {
        ProviderLimits.hero(from: providerLimits,
                            choice: PrimaryChoice(rawValue: settings.primaryProvider))
    }

    func providerLimitEnabled(_ id: String) -> Bool {
        switch id {
        case "claude": return settings.providerClaude
        case "codex": return settings.providerCodex
        case "cursor": return settings.providerCursor
        case "copilot": return settings.providerCopilot
        case "gemini": return settings.providerGemini
        default: return true
        }
    }

    var menuBarText: String? {
        MenuBarMetric.slotsText(
            [(settings.metricSlot1, settings.metricProvider1),
             (settings.metricSlot2, settings.metricProvider2),
             (settings.metricSlot3, settings.metricProvider3)],
            .init(
                summary: summary,
                worstPercent: worstPercent,
                sessionPercent: sessionPercent,
                sessionReset: sessionReset,
                sessionTokens: sessionTokens,
                weeklyPercent: weeklyPercent,
                weeklyReset: weeklyReset,
                byProvider: byProviderStats
            )
        )
    }

    // MARK: lifecycle

    func startIfNeeded() {
        guard !started else { return }
        started = true
        sidecar.onEvent = { [weak self] event in self?.handle(event) }
        sidecar.start()
        if settings.notificationsEnabled && (settings.notifyThresholds || settings.notifyReset || settings.notifyForecast) {
            notifier.requestPermission()
        }

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshRemote()
                let interval = self?.settings.limitsRefreshSeconds ?? 60
                try? await Task.sleep(for: .seconds(interval))
            }
        }
        statusTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshServiceStatus()
                try? await Task.sleep(for: .seconds(300))
            }
        }
        digestTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.maybeSendDigest()
                try? await Task.sleep(for: .seconds(60 * 10))
            }
        }
        syncTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.maybeSync()
                try? await Task.sleep(for: .seconds(5))
            }
        }

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.sidecar.requestRefresh()
                if self?.settings.syncEnabled == true {
                    await self?.syncLeaderboardNow()
                } else {
                    await self?.refreshRemote()
                }
            }
        }
    }

    func stop() {
        for t in [pollTask, statusTask, digestTask, syncTask] { t?.cancel() }
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
        sidecar.stop()
    }

    // MARK: refresh paths

    func setClaudeLimitsEnabled(_ enabled: Bool) async {
        settings.claudeLimitsEnabled = enabled
        guard enabled else {
            claudeState = .unavailable(reason: "Claude limits access is off")
            claudeForecastHit = nil
            return
        }
        if let state = await claude.fetch() {
            claudeState = state
            if case .ready(let usage) = state { feedClaudeAlerts(usage) }
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        settings.notificationsEnabled = enabled
        if enabled { notifier.requestPermission() }
    }

    func setLeaderboardSyncEnabled(_ enabled: Bool) {
        settings.syncEnabled = enabled
        leaderboardSyncState = enabled ? .waiting : .off
        if enabled {
            Task { await syncLeaderboardNow() }
        }
    }

    private func fetchClaudeIfEnabled() async -> ClaudeUsageState? {
        guard settings.claudeLimitsEnabled else { return nil }
        return await claude.fetch()
    }

    func refreshRemote() async {
        async let claudeResult = fetchClaudeIfEnabled()
        // Resolve the whoburnedmore rank FIRST so a slow/prompting Claude
        // Keychain read can never block the leaderboard context from rendering.
        await refreshLeaderboard()
        if let state = await claudeResult {
            claudeState = state
            if case .ready(let usage) = state {
                feedClaudeAlerts(usage)
            }
        }
        lastUpdatedAt = Date()
    }

    private func refreshLeaderboard() async {
        let newWbm = await wbm.fetch()
        detectOvertaken(old: wbmState, new: newWbm)
        wbmState = newWbm
        if case .ready = newWbm { recomputeStreak() }
    }

    private func feedClaudeAlerts(_ usage: ClaudeUsage) {
        let percent = usage.fiveHour?.utilization
        let now = Date()
        if let percent {
            claudeSamples.append(PercentSample(at: now, percent: percent))
            if claudeSamples.count > 240 { claudeSamples.removeFirst(claudeSamples.count - 240) }
        }
        claudeForecastHit = Forecast.limitHit(samples: claudeSamples, now: now)

        guard settings.notificationsEnabled else { return }
        claudeEdge.thresholds = [settings.warnThreshold, settings.criticalThreshold]
        for alert in claudeEdge.feed(percent) {
            let isReset = alert.kind == "reset"
            guard (isReset && settings.notifyReset) || (!isReset && settings.notifyThresholds) else { continue }
            let isCritical = Double(alert.level ?? 0) >= settings.criticalThreshold
            notifier.deliver(provider: "Claude", kind: alert.kind, level: alert.level, percent: alert.percent, isCritical: isCritical)
        }
        if settings.notifyForecast,
           forecastAlarm.feed(forecastHit: claudeForecastHit, percent: percent, now: now),
           let hit = claudeForecastHit {
            notifier.deliverForecast(provider: "Claude", hitAt: hit)
        }
    }

    private func detectOvertaken(old: WbmState, new: WbmState) {
        guard settings.notificationsEnabled, settings.notifyOvertaken,
              case .ready(let profile) = new, let newRank = profile.dailyRank else { return }
        if let prev = prevDailyRank, newRank > prev {
            notifier.deliverOvertaken(newRank: newRank)
        }
        prevDailyRank = newRank
    }

    /// Streak = consecutive non-zero days in the local 14-day series. Recomputed
    /// whenever burn data lands (below) so it doesn't wait on the whoburnedmore
    /// poll, and again after a rank refresh.
    private func recomputeStreak() {
        guard let days = summary?.days else { return }
        var streak = 0
        for day in days.reversed() {
            if day.tokens > 0 { streak += 1 } else { break }
        }
        streakDays = streak
    }

    func refreshServiceStatus() async {
        anthropicStatus = await Self.fetchStatus("https://status.anthropic.com/api/v2/status.json")
        openaiStatus = await Self.fetchStatus("https://status.openai.com/api/v2/status.json")
    }

    private static func fetchStatus(_ url: String) async -> StatusPageState? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u)
        req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return StatusPageState.decode(from: data)
    }

    private var lastDigestDay: String?

    private func maybeSendDigest() async {
        guard settings.notificationsEnabled, settings.digestEnabled, let s = summary else { return }
        let now = Date()
        let hour = Calendar.current.component(.hour, from: now)
        let day = ISO8601DateFormatter().string(from: now).prefix(10)
        guard hour >= settings.digestHour, lastDigestDay != String(day) else { return }
        lastDigestDay = String(day)
        var rank: Int?
        if case .ready(let p) = wbmState { rank = p.dailyRank }
        notifier.deliverDigest(tokens: s.today.totalTokens, costUSD: s.today.costUSD, dailyRank: rank)
    }

    func syncLeaderboardNow() async {
        let localTokens = summary?.today.totalTokens
        if let localTokens { liveSyncThrottle.observe(tokens: localTokens) }
        await performLeaderboardSync(markingTokens: localTokens, nativeOnly: false)
    }

    private func performLeaderboardSync(markingTokens: Int?, nativeOnly: Bool) async {
        guard settings.syncEnabled else {
            leaderboardSyncState = .off
            return
        }
        guard leaderboardSyncState != .syncing else { return }
        guard let sidecarURL = SidecarClient.sidecarURL() else {
            leaderboardSyncState = .failed("sync helper missing")
            return
        }
        leaderboardSyncState = .syncing

        let p = Process()
        p.executableURL = sidecarURL
        p.arguments = nativeOnly ? ["sync", "--native-only"] : ["sync"]
        var env = ProcessInfo.processInfo.environment
        if let ccusage = SidecarClient.ccusageURL() { env["BURNBAR_CCUSAGE"] = ccusage.path }
        p.environment = env
        let output = Pipe()
        p.standardOutput = output
        p.standardError = output

        let result: (ok: Bool, message: String?) = await withCheckedContinuation { continuation in
            p.terminationHandler = { finished in
                let data = output.fileHandleForReading.readDataToEndOfFile()
                let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                continuation.resume(returning: (finished.terminationStatus == 0, text))
            }
            do {
                try p.run()
            } catch {
                continuation.resume(returning: (false, error.localizedDescription))
            }
        }

        if result.ok {
            let now = Date()
            if let markingTokens { liveSyncThrottle.markSynced(tokens: markingTokens) }
            await refreshLeaderboardAfterSync()
            leaderboardSyncState = .synced(now)
            lastUpdatedAt = now
        } else {
            let message = Self.syncErrorMessage(result.message)
            leaderboardSyncState = .failed(message)
            log.error("leaderboard sync failed: \(message)")
        }
    }

    private func maybeSync() async {
        guard settings.syncEnabled, leaderboardSyncState != .syncing,
              let localTokens = summary?.today.totalTokens else { return }
        liveSyncThrottle.observe(tokens: localTokens)
        guard let dueTokens = liveSyncThrottle.beginIfDue() else { return }
        await performLeaderboardSync(markingTokens: dueTokens, nativeOnly: true)
    }

    /// The public board serves stale data while its cache recomputes. A successful
    /// upload therefore gets a few bounded follow-up reads before we label the UI
    /// synced, so the app and website converge in the same interaction.
    private func refreshLeaderboardAfterSync() async {
        let delays: [Duration] = [.milliseconds(500), .seconds(1), .seconds(2), .seconds(3)]
        for attempt in 0...delays.count {
            await refreshLeaderboard()
            guard let localToday = summary?.today.totalTokens,
                  case .ready(let profile) = wbmState,
                  profile.dailyRank != nil else { return }
            let syncedToday = profile.leaderboardContext.first {
                $0.handle.caseInsensitiveCompare(profile.handle) == .orderedSame
            }?.todayTokens
            if syncedToday == localToday { return }
            if attempt < delays.count {
                try? await Task.sleep(for: delays[attempt])
            }
        }
    }

    private static func syncErrorMessage(_ output: String?) -> String {
        guard let output, !output.isEmpty else { return "upload failed" }
        if output.contains("not-connected") || output.contains("unauthorized") {
            return "connect your account"
        }
        if output.contains("no-usage") { return "no usage found" }
        return "upload failed"
    }

    // MARK: sidecar events

    private func handle(_ event: SidecarEvent) {
        switch event {
        case .snapshot(let s):
            summary = s
            liveSyncThrottle.observe(tokens: s.today.totalTokens)
            sessionTokens = sessionMeter.feed(
                todayTokens: s.today.totalTokens,
                windowResetAt: sessionReset
            )
            recomputeStreak()
            lastUpdatedAt = Date()
            if settings.syncEnabled {
                Task { [weak self] in await self?.maybeSync() }
            }
        case .limits(let l):
            codexLimits = l.codex
            cursorLimits = l.cursor
        case .alert(let kind, let provider, let level, let percent):
            let isReset = kind == "reset"
            if settings.notificationsEnabled && ((isReset && settings.notifyReset) || (!isReset && settings.notifyThresholds)) {
                let isCritical = Double(level ?? 0) >= settings.criticalThreshold
                notifier.deliver(provider: provider.capitalized, kind: kind, level: level, percent: percent, isCritical: isCritical)
            }
        case .status(let isCollecting, _, let error):
            collecting = isCollecting
            if let error { log.warning("sidecar status error: \(error)") }
        case .hello, .heartbeat, .unknown:
            break
        }
    }
}
