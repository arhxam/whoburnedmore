import AppKit
import BurnBarCore
import Foundation
import os

@MainActor
final class AppModel: ObservableObject {
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
    private var started = false

    init(settings: SettingsStore) {
        self.settings = settings
    }

    // MARK: derived state

    /// The tightest window across ENABLED providers.
    var worstPercent: Double? {
        var percents: [Double] = []
        if settings.providerClaude, case .ready(let usage) = claudeState {
            if let p = usage.fiveHour?.utilization { percents.append(p) }
            if let p = usage.sevenDay?.utilization { percents.append(p) }
            percents.append(contentsOf: usage.scoped.compactMap(\.percent))
        }
        if settings.providerCodex, let c = codexLimits {
            if let p = c.primary?.usedPercent { percents.append(p) }
            if let p = c.secondary?.usedPercent { percents.append(p) }
        }
        if settings.providerCursor, let p = cursorLimits?.planPercent { percents.append(p) }
        return percents.max()
    }

    var sessionPercent: Double? {
        guard case .ready(let usage) = claudeState else { return nil }
        return usage.fiveHour?.utilization
    }

    var sessionReset: Date? {
        guard case .ready(let usage) = claudeState else { return nil }
        return Formatters.parseISO(usage.fiveHour?.resetsAt)
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
        return usage.sevenDay?.utilization
    }

    var weeklyReset: Date? {
        guard case .ready(let usage) = claudeState else { return nil }
        return Formatters.parseISO(usage.sevenDay?.resetsAt)
    }

    var menuBarText: String? {
        MenuBarMetric.slotsText(
            [settings.metricSlot1, settings.metricSlot2, settings.metricSlot3],
            .init(
                summary: summary,
                worstPercent: worstPercent,
                sessionPercent: sessionPercent,
                sessionReset: sessionReset,
                sessionTokens: sessionTokens,
                weeklyPercent: weeklyPercent,
                weeklyReset: weeklyReset
            )
        )
    }

    // MARK: lifecycle

    func startIfNeeded() {
        guard !started else { return }
        started = true
        sidecar.onEvent = { [weak self] event in self?.handle(event) }
        sidecar.start()
        if settings.notifyThresholds || settings.notifyReset || settings.notifyForecast {
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
                try? await Task.sleep(for: .seconds(15 * 60))
            }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.sidecar.requestRefresh()
                await self?.refreshRemote()
            }
        }
    }

    func stop() {
        for t in [pollTask, statusTask, digestTask, syncTask] { t?.cancel() }
        sidecar.stop()
    }

    // MARK: refresh paths

    func refreshRemote() async {
        async let claudeResult = claude.fetch()
        async let wbmResult = wbm.fetch()
        if let state = await claudeResult {
            claudeState = state
            if case .ready(let usage) = state {
                feedClaudeAlerts(usage)
            }
        }
        let newWbm = await wbmResult
        detectOvertaken(old: wbmState, new: newWbm)
        wbmState = newWbm
        if case .ready(let profile) = newWbm { updateStreak(profile) }
        lastUpdatedAt = Date()
    }

    private func feedClaudeAlerts(_ usage: ClaudeUsage) {
        let percent = usage.fiveHour?.utilization
        let now = Date()
        if let percent {
            claudeSamples.append(PercentSample(at: now, percent: percent))
            if claudeSamples.count > 240 { claudeSamples.removeFirst(claudeSamples.count - 240) }
        }
        claudeForecastHit = Forecast.limitHit(samples: claudeSamples, now: now)

        claudeEdge.thresholds = [settings.warnThreshold, settings.criticalThreshold]
        for alert in claudeEdge.feed(percent) {
            let isReset = alert.kind == "reset"
            guard (isReset && settings.notifyReset) || (!isReset && settings.notifyThresholds) else { continue }
            notifier.deliver(provider: "Claude", kind: alert.kind, level: alert.level, percent: alert.percent)
        }
        if settings.notifyForecast,
           forecastAlarm.feed(forecastHit: claudeForecastHit, percent: percent, now: now),
           let hit = claudeForecastHit {
            notifier.deliverForecast(provider: "Claude", hitAt: hit)
        }
    }

    private func detectOvertaken(old: WbmState, new: WbmState) {
        guard settings.notifyOvertaken,
              case .ready(let profile) = new, let newRank = profile.dailyRank else { return }
        if let prev = prevDailyRank, newRank > prev {
            notifier.deliverOvertaken(newRank: newRank)
        }
        prevDailyRank = newRank
    }

    private func updateStreak(_ profile: WbmProfile) {
        // Streak = consecutive non-zero days in the local 14-day series (server
        // streak needs no extra call this way; capped at 14 by data available).
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
        guard settings.digestEnabled, let s = summary else { return }
        let now = Date()
        let hour = Calendar.current.component(.hour, from: now)
        let day = ISO8601DateFormatter().string(from: now).prefix(10)
        guard hour >= settings.digestHour, lastDigestDay != String(day) else { return }
        lastDigestDay = String(day)
        var rank: Int?
        if case .ready(let p) = wbmState { rank = p.dailyRank }
        notifier.deliverDigest(tokens: s.today.totalTokens, costUSD: s.today.costUSD, dailyRank: rank)
    }

    private func maybeSync() async {
        guard settings.syncEnabled else { return }
        guard let sidecarURL = SidecarClient.sidecarURL() else { return }
        let p = Process()
        p.executableURL = sidecarURL
        p.arguments = ["sync"]
        var env = ProcessInfo.processInfo.environment
        if let ccusage = SidecarClient.ccusageURL() { env["BURNBAR_CCUSAGE"] = ccusage.path }
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    // MARK: sidecar events

    private func handle(_ event: SidecarEvent) {
        switch event {
        case .snapshot(let s):
            summary = s
            sessionTokens = sessionMeter.feed(
                todayTokens: s.today.totalTokens,
                windowResetAt: sessionReset
            )
            lastUpdatedAt = Date()
        case .limits(let l):
            codexLimits = l.codex
            cursorLimits = l.cursor
        case .alert(let kind, let provider, let level, let percent):
            let isReset = kind == "reset"
            if (isReset && settings.notifyReset) || (!isReset && settings.notifyThresholds) {
                notifier.deliver(provider: provider.capitalized, kind: kind, level: level, percent: percent)
            }
        case .status(let isCollecting, _, let error):
            collecting = isCollecting
            if let error { log.warning("sidecar status error: \(error)") }
        case .hello, .heartbeat, .unknown:
            break
        }
    }
}
