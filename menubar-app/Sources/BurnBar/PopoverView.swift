import AppKit
import BurnBarCore
import Charts
import SwiftUI

/// The popover: limits · burn · tools · sessions · whoburnedmore, every zone
/// individually toggleable from Settings (SettingsStore drives visibility).
struct PopoverView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    /// Temporary bisect hook: BURNBAR_ZONES="limits,burn,tools,sessions,wbm"
    private var zoneFilter: Set<String> {
        guard let raw = ProcessInfo.processInfo.environment["BURNBAR_ZONES"] else {
            return ["limits", "burn", "tools", "sessions", "wbm"]
        }
        return Set(raw.split(separator: ",").map(String.init))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if settings.showLimits, zoneFilter.contains("limits") { LimitsZone(); Divider() }
            if settings.showBurn, zoneFilter.contains("burn") { BurnZone(); Divider() }
            if settings.showTools, zoneFilter.contains("tools") { ToolsZone(); Divider() }
            if settings.showSessions, zoneFilter.contains("sessions") { SessionsZone(); Divider() }
            if settings.showWbm, zoneFilter.contains("wbm") { WbmZone() }
            FooterZone()
        }
        .padding(14)
        .frame(width: 330)
    }
}

// MARK: Zone — Limits

struct LimitsZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Limits").font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
                if settings.showStatusDot { StatusDots() }
                Spacer()
                if model.collecting { ProgressView().controlSize(.mini) }
            }

            switch model.claudeState {
            case .ready(let usage):
                if settings.providerClaude {
                    if let fh = usage.fiveHour {
                        LimitRow(
                            name: "Claude · 5h window",
                            percent: fh.utilization,
                            resetsAt: Formatters.parseISO(fh.resetsAt),
                            forecastAt: settings.showForecast ? model.claudeForecastHit : nil,
                            warn: settings.warnThreshold, critical: settings.criticalThreshold
                        )
                    }
                    if let wk = usage.sevenDay {
                        LimitRow(
                            name: "Claude · weekly",
                            percent: wk.utilization,
                            resetsAt: Formatters.parseISO(wk.resetsAt),
                            forecastAt: nil,
                            warn: settings.warnThreshold, critical: settings.criticalThreshold
                        )
                    }
                    if settings.showPerModel {
                        ForEach(scopedRows(usage), id: \.name) { row in
                            LimitRow(
                                name: row.name, percent: row.percent, resetsAt: row.resets,
                                forecastAt: nil,
                                warn: settings.warnThreshold, critical: settings.criticalThreshold
                            )
                        }
                    }
                }
            case .stale(let reason), .unavailable(let reason):
                if settings.providerClaude {
                    Label(reason, systemImage: "moon.zzz").font(.caption).foregroundStyle(.secondary)
                }
            }

            if settings.providerCodex, let codex = model.codexLimits, codex.present {
                if let p = codex.primary {
                    LimitRow(
                        name: "Codex · \(p.label)", percent: p.usedPercent,
                        resetsAt: Formatters.parseISO(p.resetsAt),
                        forecastAt: settings.showForecast ? Formatters.parseISO(p.forecastHitAt) : nil,
                        warn: settings.warnThreshold, critical: settings.criticalThreshold
                    )
                }
                if let s = codex.secondary {
                    LimitRow(
                        name: "Codex · \(s.label)", percent: s.usedPercent,
                        resetsAt: Formatters.parseISO(s.resetsAt), forecastAt: nil,
                        warn: settings.warnThreshold, critical: settings.criticalThreshold
                    )
                }
                if codex.primary == nil, codex.secondary == nil {
                    Label(
                        "Codex · plan \(codex.planType ?? "active") — no window pressure",
                        systemImage: "checkmark.circle"
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
            }

            if settings.providerCursor, let cursor = model.cursorLimits, cursor.present {
                LimitRow(
                    name: "Cursor · plan usage", percent: cursor.planPercent,
                    resetsAt: Formatters.parseISO(cursor.renewsAt), forecastAt: nil,
                    warn: settings.warnThreshold, critical: settings.criticalThreshold
                )
            }
        }
    }

    private func scopedRows(_ usage: ClaudeUsage) -> [(name: String, percent: Double?, resets: Date?)] {
        usage.scoped
            .filter { $0.kind == "weekly_scoped" && $0.modelName != nil }
            .map { ("Claude · \($0.modelName!) weekly", $0.percent, Formatters.parseISO($0.resetsAt)) }
    }
}

/// Anthropic/OpenAI service health as tiny traffic lights.
struct StatusDots: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 4) {
            dot(model.anthropicStatus, help: "Anthropic status")
            dot(model.openaiStatus, help: "OpenAI status")
        }
    }

    @ViewBuilder
    private func dot(_ state: StatusPageState?, help: String) -> some View {
        Circle()
            .fill(color(state))
            .frame(width: 6, height: 6)
            .help("\(help): \(state?.description ?? state?.indicator ?? "unknown")")
            .accessibilityLabel("\(help) \(state?.severity ?? "unknown")")
    }

    private func color(_ state: StatusPageState?) -> Color {
        switch state?.severity {
        case "green": return .green
        case "yellow": return .yellow
        case "red": return .red
        default: return .gray.opacity(0.5)
        }
    }
}

struct LimitRow: View {
    let name: String
    let percent: Double?
    let resetsAt: Date?
    let forecastAt: Date?
    var warn: Double = 80
    var critical: Double = 95

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(name).font(.callout)
                Spacer()
                if let percent {
                    Text("\(Int(percent.rounded()))%")
                        .font(.callout.monospacedDigit().weight(.semibold))
                        .foregroundStyle(barColor)
                }
            }
            if let percent {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary)
                        Capsule()
                            .fill(barColor)
                            .frame(width: max(3, geo.size.width * min(percent, 100) / 100))
                    }
                }
                .frame(height: 5)
            }
            HStack(spacing: 8) {
                if let resetsAt {
                    Text("resets in \(Formatters.countdown(to: resetsAt))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let forecastAt, forecastAt.timeIntervalSinceNow < 12 * 3600 {
                    Text("cap ~\(forecastAt.formatted(date: .omitted, time: .shortened)) at this pace")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
        }
    }

    private var barColor: Color {
        guard let p = percent else { return .green }
        if p >= critical { return .red }
        if p >= warn { return .orange }
        return .green
    }
}

// MARK: Zone — Burn (Swift Charts)

struct BurnZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Burn").font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
                if model.summary?.partial == true {
                    Text("indexing…").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if let s = model.summary {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    StatBlock(title: "today", tokens: s.today.totalTokens, cost: s.today.costUSD)
                    StatBlock(title: "this week", tokens: s.week.totalTokens, cost: s.week.costUSD)
                    if settings.showStreak, model.streakDays > 1 {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("🔥 \(model.streakDays)").font(.title3.weight(.bold))
                            Text("day streak").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                BurnChart(days: s.days)
                    .frame(height: 46)
            } else {
                Text("Collecting local usage…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct StatBlock: View {
    let title: String
    let tokens: Int
    let cost: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Formatters.compactTokens(tokens))
                .font(.title2.monospacedDigit().weight(.bold))
            Text("\(title) · \(Formatters.usd(cost))")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}

/// 14-day burn as a Swift Charts bar chart. (No hover overlay: chartOverlay +
/// GeometryReader inside NSHostingController triggers an AutoLayout
/// constraints loop — see the v2 crash bisect. The per-bar .help tooltip
/// carries the detail instead.)
struct BurnChart: View {
    let days: [DayPoint]

    var body: some View {
        Chart(days, id: \.date) { day in
            BarMark(
                x: .value("Day", shortDay(day.date)),
                y: .value("Tokens", day.tokens)
            )
            .foregroundStyle(
                day.date == days.last?.date ? Color.orange : Color.orange.opacity(0.45)
            )
            .cornerRadius(2)
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisValueLabel().font(.system(size: 8)).foregroundStyle(.tertiary)
            }
        }
        .chartYAxis(.hidden)
        .help(days.map { "\($0.date): \(Formatters.compactTokens($0.tokens))" }.suffix(3).joined(separator: "\n"))
        .accessibilityLabel("14-day burn chart")
    }

    private func shortDay(_ date: String) -> String {
        String(date.suffix(5)) // MM-DD
    }
}

// MARK: Zone — Tools & models

struct ToolsZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Top tools today")
                .font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
            if let s = model.summary {
                let all = s.byToolToday.isEmpty ? s.byTool14d : s.byToolToday
                let rows = all.filter { settings.providerEnabled($0.tool) }
                if rows.isEmpty {
                    Text("No usage yet today").font(.caption).foregroundStyle(.secondary)
                }
                let maxTokens = max(rows.first?.tokens ?? 1, 1)
                ForEach(rows.prefix(5)) { row in
                    VStack(alignment: .leading, spacing: 1) {
                        HStack {
                            Text(row.tool).font(.callout)
                            Spacer()
                            Text(Formatters.compactTokens(row.tokens))
                                .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        GeometryReader { geo in
                            Capsule().fill(Color.orange.opacity(0.35))
                                .frame(width: max(2, geo.size.width * CGFloat(row.tokens) / CGFloat(maxTokens)))
                        }
                        .frame(height: 3)
                    }
                }
                if !s.topModelsToday.isEmpty {
                    Text(s.topModelsToday.prefix(3).map(\.model).joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
    }
}

// MARK: Zone — Sessions

struct SessionsZone: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Biggest sessions today")
                .font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
            let sessions = model.summary?.sessionsToday ?? []
            if sessions.isEmpty {
                Text("No sessions yet today").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(sessions.prefix(3)) { s in
                HStack {
                    Text(s.name).font(.caption).lineLimit(1)
                    Spacer()
                    Text(Formatters.compactTokens(s.tokens))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: Zone — whoburnedmore

struct WbmZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        switch model.wbmState {
        case .noAccount:
            VStack(alignment: .leading, spacing: 6) {
                Text("See how you rank 🏆").font(.callout.weight(.semibold))
                Text("Your burn vs every AI coder on whoburnedmore.com — optional, one click.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Join the leaderboard") {
                        SettingsWindow.show(model: model, settings: settings)
                    }
                    .buttonStyle(.borderedProminent).tint(.orange).controlSize(.small)
                    Button("Hide") { settings.showWbm = false }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
            }
        case .offline(let handle):
            HStack {
                Image(systemName: "wifi.slash")
                Text("@\(handle) — whoburnedmore offline").font(.caption)
            }
            .foregroundStyle(.secondary)
        case .ready(let profile):
            Button {
                if let url = WbmClient.profileURL() { NSWorkspace.shared.open(url) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "trophy").foregroundStyle(.orange)
                    Text("@\(profile.handle)").font(.callout.weight(.medium))
                    Spacer()
                    if let rank = profile.rank {
                        Text("#\(rank)").font(.callout.monospacedDigit().weight(.semibold))
                    }
                    if let daily = profile.dailyRank {
                        Text("today #\(daily)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open your whoburnedmore profile")
        }
    }
}

// MARK: Footer

struct FooterZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        HStack {
            if let t = model.lastUpdatedAt {
                Text("updated \(t.formatted(date: .omitted, time: .standard))")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            HStack(spacing: 12) {
                Button {
                    let web = ProcessInfo.processInfo.environment["WHOBURNEDMORE_WEB"] ?? "https://whoburnedmore.com"
                    if let url = URL(string: web) { NSWorkspace.shared.open(url) }
                } label: {
                    Image(systemName: "globe")
                }
                .buttonStyle(.plain)
                .help("Open whoburnedmore.com")

                Button {
                    SettingsWindow.show(model: model, settings: settings)
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.plain)
                .help("Settings")

                Button {
                    NSApp.terminate(nil)
                } label: {
                    Image(systemName: "power")
                }
                .buttonStyle(.plain)
                .help("Quit BurnBar")
            }
        }
    }
}
