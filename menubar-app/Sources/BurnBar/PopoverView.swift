import AppKit
import BurnBarCore
import SwiftUI

/// The popover: limits (rings + per-provider detail, optional hero) · burn ·
/// tools · whoburnedmore. Every zone and provider is toggleable from Settings.
struct PopoverView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if settings.showLimits { LimitsZone(); Divider() }
            if settings.showBurn { BurnZone(); Divider() }
            if settings.showTools { ToolsZone(); Divider() }
            if settings.showWbm { WbmZone() }
            FooterZone()
        }
        .padding(14)
        .frame(width: 340)
    }
}

// MARK: threshold colour

func limitColor(_ percent: Double?, warn: Double, critical: Double) -> Color {
    guard let p = percent else { return .secondary }
    if p >= critical { return .red }
    if p >= warn { return Color(red: 0.96, green: 0.71, blue: 0.24) }
    return Color(red: 0.27, green: 0.84, blue: 0.54)
}

// MARK: Zone — Limits

struct LimitsZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        let limits = model.providerLimits
        let hero = model.heroProvider
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("Limits").font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
                if settings.showStatusDot { StatusDots() }
                Spacer()
                if model.collecting {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                        .help("Refreshing usage…")
                }
                Button {
                    if let url = URL(string: "https://claude.ai/settings/usage") { NSWorkspace.shared.open(url) }
                } label: { Text("usage ↗").font(.caption2).foregroundStyle(.tertiary) }
                    .buttonStyle(.plain)
            }

            if limits.isEmpty {
                Label("No limit data yet — connect a provider in Settings.", systemImage: "moon.zzz")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                if let hero { HeroRing(provider: hero) }

                // Rings row — one headline gauge per provider.
                HStack(alignment: .top, spacing: 4) {
                    ForEach(limits) { p in
                        MiniRing(provider: p)
                            .frame(maxWidth: .infinity)
                    }
                }

                // Per-provider detail — each provider's own metrics beneath.
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(limits) { p in
                        ProviderDetail(provider: p)
                    }
                }
            }
        }
    }
}

/// Big hero ring for the primary/tightest provider (Settings → Menu bar).
struct HeroRing: View {
    @EnvironmentObject private var settings: SettingsStore
    let provider: ProviderLimit

    var body: some View {
        let m = provider.headline
        let color = limitColor(m?.percent, warn: settings.warnThreshold, critical: settings.criticalThreshold)
        HStack(spacing: 15) {
            ZStack {
                RingShape(percent: m?.percent, color: color, lineWidth: 7)
                VStack(spacing: 0) {
                    Text(m?.percent.map { "\(Int($0.rounded()))%" } ?? "—")
                        .font(.system(size: 25, weight: .heavy, design: .rounded)).foregroundStyle(color)
                    Text(settings.primaryProvider == "tightest" ? "tightest" : "primary")
                        .font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
                        .textCase(.uppercase).tracking(0.6)
                }
            }
            .frame(width: 90, height: 90)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) { ProviderMark(id: provider.id, size: 14); Text("\(provider.name) · \(m?.label ?? "")").font(.callout.weight(.semibold)) }
                if let r = m?.reset {
                    LiveResetCountdown(reset: r, prefix: "resets in ")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if settings.showForecast, let f = m?.forecast, f.timeIntervalSinceNow < 12 * 3600 {
                    Label("hits cap ~\(f.formatted(date: .omitted, time: .shortened)) at this pace",
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

/// Small headline ring for one provider (the rings row).
struct MiniRing: View {
    @EnvironmentObject private var settings: SettingsStore
    let provider: ProviderLimit

    var body: some View {
        let m = provider.headline
        let color = limitColor(m?.percent, warn: settings.warnThreshold, critical: settings.criticalThreshold)
        VStack(spacing: 6) {
            ZStack {
                RingShape(percent: m?.percent, color: color, lineWidth: 5)
                Text(m?.percent.map { "\(Int($0.rounded()))%" } ?? "–")
                    .font(.system(size: 13, weight: .heavy, design: .rounded)).foregroundStyle(color)
            }
            .frame(width: 56, height: 56)
            HStack(spacing: 4) {
                ProviderMark(id: provider.id, size: 11)
                Text(provider.name).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            if let reset = m?.reset {
                LiveResetCountdown(reset: reset)
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
            } else {
                Text(" ").font(.system(size: 9))
            }
        }
    }
}

/// A stroked circular gauge.
struct RingShape: View {
    let percent: Double?
    let color: Color
    var lineWidth: CGFloat = 5
    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.09), lineWidth: lineWidth)
            if let p = percent {
                Circle().trim(from: 0, to: min(max(p, 0), 100) / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
    }
}

/// Per-provider detail: the provider's chip + name, then its metric rows —
/// different metrics for each provider (weekly, per-model, credits, …).
struct ProviderDetail: View {
    @EnvironmentObject private var settings: SettingsStore
    let provider: ProviderLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                ProviderChip(id: provider.id)
                Text(provider.name).font(.caption.weight(.semibold))
            }
            ForEach(provider.metrics) { m in
                HStack(spacing: 8) {
                    Text(m.label).font(.caption).foregroundStyle(.secondary)
                    if let reset = m.reset {
                        LiveResetCountdown(reset: reset, prefix: "resets ")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                    Spacer(minLength: 6)
                    if let note = m.note {
                        Text(note).font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let p = m.percent {
                        MiniBar(percent: p).frame(width: 54)
                        Text("\(Int(p.rounded()))%")
                            .font(.caption.monospacedDigit().weight(.medium))
                            .foregroundStyle(limitColor(p, warn: settings.warnThreshold, critical: settings.criticalThreshold))
                            .frame(width: 34, alignment: .trailing)
                    }
                }
                .padding(.leading, 2)
            }
        }
    }
}

/// A countdown must keep moving while the popover is open, even when a
/// provider has not emitted a new usage payload. SwiftUI suspends this periodic
/// timeline with the view, so it costs nothing while the menu is closed.
struct LiveResetCountdown: View {
    let reset: Date
    var prefix = ""

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text("\(prefix)\(Formatters.countdown(to: reset, from: context.date))")
                .monospacedDigit()
                .lineLimit(1)
        }
    }
}

struct MiniBar: View {
    @EnvironmentObject private var settings: SettingsStore
    let percent: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.09))
                Capsule().fill(limitColor(percent, warn: settings.warnThreshold, critical: settings.criticalThreshold))
                    .frame(width: max(3, geo.size.width * min(percent, 100) / 100))
            }
        }
        .frame(height: 4)
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
    @ViewBuilder private func dot(_ state: StatusPageState?, help: String) -> some View {
        Circle().fill(color(state)).frame(width: 6, height: 6)
            .help("\(help): \(state?.description ?? state?.indicator ?? "unknown")")
    }
    private func color(_ s: StatusPageState?) -> Color {
        switch s?.severity {
        case "green": return .green
        case "yellow": return .yellow
        case "red": return .red
        default: return .gray.opacity(0.5)
        }
    }
}

// MARK: Zone — Burn (clean sparkline, no date axis)

struct BurnZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Burn").font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
                if model.summary?.partial == true {
                    Text("indexing…").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if let s = model.summary {
                HStack(alignment: .firstTextBaseline, spacing: 18) {
                    StatBlock(title: "today", tokens: s.today.totalTokens, cost: s.today.costUSD)
                    StatBlock(title: "this week", tokens: s.week.totalTokens, cost: s.week.costUSD)
                    if settings.showStreak, model.streakDays > 1 {
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 1) {
                            HStack(spacing: 3) { BurnFlame(size: 14); Text("\(model.streakDays)").font(.title3.weight(.bold)) }
                            Text("day streak").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                Sparkline(days: s.days).frame(height: 32)
            } else {
                Text("Collecting local usage…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct StatBlock: View {
    let title: String; let tokens: Int; let cost: Double
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Formatters.compactTokens(tokens)).font(.title2.monospacedDigit().weight(.bold))
            Text("\(title) · \(Formatters.usd(cost))").font(.caption2).foregroundStyle(.secondary)
        }
    }
}

/// 14-day burn as a clean bar sparkline — no axis, no date labels (the old
/// Swift Charts version overlapped its date labels). Last bar is the accent.
struct Sparkline: View {
    let days: [DayPoint]
    var body: some View {
        GeometryReader { geo in
            let maxTokens = max(days.map(\.tokens).max() ?? 1, 1)
            let gap: CGFloat = 3
            let w = (geo.size.width - CGFloat(max(days.count - 1, 0)) * gap) / CGFloat(max(days.count, 1))
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(days, id: \.date) { d in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(d.date == days.last?.date ? Color.orange : Color.orange.opacity(0.4))
                        .frame(width: max(w, 2),
                               height: max(2, geo.size.height * CGFloat(d.tokens) / CGFloat(maxTokens)))
                        .help("\(d.date): \(Formatters.compactTokens(d.tokens))")
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .accessibilityLabel("14-day burn sparkline")
    }
}

// MARK: Zone — Tools & models

struct ToolsZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Top tools today").font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
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

// MARK: Zone — whoburnedmore

struct WbmZone: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        switch model.wbmState {
        case .noAccount:
            VStack(alignment: .leading, spacing: 6) {
                Label { Text("See how you rank").font(.callout.weight(.semibold)) }
                icon: { Image(systemName: "trophy.fill").foregroundStyle(.orange) }
                Text("Your burn vs every AI coder on whoburnedmore.com — optional, one click.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Join the leaderboard") { SettingsWindow.show(model: model, settings: settings) }
                        .buttonStyle(.borderedProminent).tint(.orange).controlSize(.small)
                    Button("Hide") { settings.showWbm = false }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
            }
        case .offline(let handle):
            HStack { Image(systemName: "wifi.slash"); Text("@\(handle) — whoburnedmore offline").font(.caption) }
                .foregroundStyle(.secondary)
        case .ready(let profile):
            if profile.leaderboardContext.isEmpty {
                WbmRankStrip(profile: profile)
            } else {
                LeaderboardContext(profile: profile)
            }
        }
    }
}

private struct WbmRankStrip: View {
    let profile: WbmProfile

    var body: some View {
        Button {
            if let url = WbmClient.profileURL() { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "trophy.fill").foregroundStyle(.orange)
                Text("@\(profile.handle)").font(.callout.weight(.medium))
                Spacer()
                if let daily = profile.dailyRank {
                    Text("today #\(daily)").font(.callout.monospacedDigit().weight(.semibold))
                } else {
                    Text("not ranked today").font(.caption).foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open your whoburnedmore profile")
    }
}

private struct LeaderboardContext: View {
    @EnvironmentObject private var model: AppModel
    let profile: WbmProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "trophy.fill").foregroundStyle(.orange)
                Text("Today’s leaderboard").font(.caption.weight(.semibold))
                syncStatus
                Spacer()
                Button {
                    if !model.settings.syncEnabled {
                        model.setLeaderboardSyncEnabled(true)
                    } else {
                        Task { await model.syncLeaderboardNow() }
                    }
                } label: {
                    Text("Sync now")
                }
                .buttonStyle(.plain)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.orange)
                .disabled(model.leaderboardSyncState == .syncing)
            }

            Button {
                if let url = WbmClient.profileURL() { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(profile.leaderboardContext.enumerated()), id: \.element.id) { index, row in
                    if index > 0, row.rank - profile.leaderboardContext[index - 1].rank > 1 {
                        HStack(spacing: 6) {
                            Rectangle().fill(Color.secondary.opacity(0.16)).frame(height: 1)
                            Text("•••").font(.system(size: 7)).foregroundStyle(.tertiary)
                            Rectangle().fill(Color.secondary.opacity(0.16)).frame(height: 1)
                        }
                        .frame(height: 8)
                    }
                    LeaderboardContextRow(row: row, isMe: row.handle.caseInsensitiveCompare(profile.handle) == .orderedSame)
                }

                HStack(spacing: 4) {
                    Text("@\(profile.handle)")
                    if let dailyRank = profile.leaderboardContext.first(where: {
                        $0.handle.caseInsensitiveCompare(profile.handle) == .orderedSame
                    })?.rank {
                        Text("· today #\(dailyRank)")
                    } else {
                        Text("· not ranked today")
                    }
                    Spacer()
                    if let local = model.summary?.today.totalTokens,
                       let synced = profile.leaderboardContext.first(where: {
                           $0.handle.caseInsensitiveCompare(profile.handle) == .orderedSame
                       })?.todayTokens,
                       local != synced {
                        Text("local \(Formatters.compactTokens(local)) · synced \(Formatters.compactTokens(synced))")
                    } else {
                        Text("daily tokens")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open your whoburnedmore profile")
        }
    }

    @ViewBuilder
    private var syncStatus: some View {
        Group {
            switch model.leaderboardSyncState {
            case .off:
                Text("sync off").foregroundStyle(.secondary)
            case .waiting:
                Text("waiting").foregroundStyle(.secondary)
            case .syncing:
                ProgressView().controlSize(.mini)
                Text("syncing").foregroundStyle(.orange)
            case .synced:
                Circle().fill(Color.green).frame(width: 5, height: 5)
                Text("synced").foregroundStyle(.green)
            case .failed(let message):
                Circle().fill(Color.red).frame(width: 5, height: 5)
                Text(message).foregroundStyle(.red)
            }
        }
        .font(.caption2.weight(.medium))
    }
}

private struct LeaderboardContextRow: View {
    let row: WbmLeaderboardEntry
    let isMe: Bool

    var body: some View {
        HStack(spacing: 7) {
            Group {
                if row.rank == 1 {
                    Image(systemName: "crown.fill").font(.system(size: 9)).foregroundStyle(.orange)
                } else {
                    Text("#\(row.rank)").font(.caption2.monospacedDigit().weight(.semibold))
                }
            }
            .frame(width: 28, alignment: .trailing)

            Text(row.displayName.isEmpty ? "@\(row.handle)" : row.displayName)
                .font(.caption.weight(isMe ? .semibold : .regular))
                .lineLimit(1)
            if isMe {
                Text("you")
                    .font(.system(size: 8, weight: .bold))
                    .textCase(.uppercase)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .foregroundStyle(.black)
                    .background(Color.orange, in: Capsule())
            }
            Spacer(minLength: 6)
            Text(Formatters.compactTokens(row.todayTokens))
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(isMe ? .orange : .secondary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(isMe ? Color.orange.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
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
                } label: { Image(systemName: "globe") }
                    .buttonStyle(.plain).help("Open whoburnedmore.com")
                Button { SettingsWindow.show(model: model, settings: settings) } label: { Image(systemName: "gearshape") }
                    .buttonStyle(.plain).help("Settings")
                Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }
                    .buttonStyle(.plain).help("Quit BurnBar")
            }
        }
    }
}
