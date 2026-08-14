import AppKit
import BurnBarCore
import SwiftUI

@MainActor
final class IslandPresentationModel: ObservableObject {
    @Published var state: IslandPresentationState
    @Published var layout: IslandLayout

    init(state: IslandPresentationState = .dormant, layout: IslandLayout) {
        self.state = state
        self.layout = layout
    }
}

/// A transparent trigger while idle, one value on hover, and a purpose-built
/// compact dashboard after click. Nothing is permanently placed beside the
/// system menu-bar items.
struct IslandSurfaceView: View {
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @ObservedObject var presentation: IslandPresentationModel
    @ObservedObject var model: AppModel
    @ObservedObject var settings: SettingsStore
    let onToggle: () -> Void
    var renderStatic = false

    private var expanded: Bool { presentation.state == .expanded }
    private var revealed: Bool { presentation.state == .revealed }

    var body: some View {
        ZStack(alignment: .top) {
            if expanded {
                IslandBackground(hasNotch: presentation.layout.hasNotch)
                    .fill(Color.black)
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else if revealed {
                compactContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else {
                Color.clear
            }
        }
        .environmentObject(model)
        .environmentObject(settings)
        .environment(\.colorScheme, .dark)
        .contentShape(Rectangle())
        .shadow(color: expanded ? .black.opacity(0.5) : .clear, radius: 24, x: 0, y: 14)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(expanded ? "BurnBar dashboard" : "BurnBar hover value")
        .animation(
            accessibilityReduceMotion
                ? .linear(duration: 0.01)
                : .spring(response: 0.34, dampingFraction: 0.86),
            value: presentation.state
        )
    }

    private var compactContent: some View {
        Button(action: onToggle) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                Text(model.islandMetricText ?? "—")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(limitColor(model.worstPercent, warn: settings.warnThreshold, critical: settings.criticalThreshold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .padding(.horizontal, 13)
                    .frame(minWidth: 62, minHeight: 30)
                    .background(Color.black, in: Capsule())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open BurnBar, \(model.islandMetricText ?? "no value")")
        .accessibilityHint("Expands from the camera area")
    }

    private var expandedContent: some View {
        VStack(spacing: 0) {
            IslandHeader(model: model, onCollapse: onToggle)
                .padding(.top, presentation.layout.hasNotch ? 32 : 4)
                .frame(height: presentation.layout.hasNotch ? 88 : 60, alignment: .bottom)

            Rectangle().fill(Color.white.opacity(0.09)).frame(height: 1)

            if renderStatic {
                IslandDashboard(model: model, settings: settings)
                    .frame(maxWidth: .infinity, alignment: .top)
            } else {
                ScrollView {
                    IslandDashboard(model: model, settings: settings)
                        .frame(maxWidth: .infinity, alignment: .top)
                }
                .scrollIndicators(.hidden)
            }
        }
        .clipShape(IslandBackground(hasNotch: presentation.layout.hasNotch))
    }
}

private struct IslandHeader: View {
    @ObservedObject var model: AppModel
    let onCollapse: () -> Void

    var body: some View {
        HStack(spacing: 11) {
            Image(nsImage: BurnBarBrandIcon.image)
                .resizable()
                .interpolation(.high)
                .frame(width: 38, height: 38)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityLabel("BurnBar")

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("BurnBar")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                    Circle().fill(Color.green).frame(width: 5, height: 5)
                    Text("live")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.green)
                        .textCase(.uppercase)
                        .tracking(0.6)
                }
                Text(headerDetail)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button(action: onCollapse) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.09), in: Circle())
            }
            .buttonStyle(.plain)
            .help("Close BurnBar")
            .accessibilityLabel("Close BurnBar")
        }
        .padding(.horizontal, 16)
        .frame(height: 56)
    }

    private var headerDetail: String {
        if model.collecting { return "updating local usage…" }
        guard let date = model.lastUpdatedAt else { return "starting local collectors…" }
        return "updated \(date.formatted(date: .omitted, time: .shortened))"
    }
}

private struct IslandDashboard: View {
    @ObservedObject var model: AppModel
    @ObservedObject var settings: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            overview

            if let summary = model.summary {
                IslandBurnChart(days: summary.days)
                    .frame(height: 90)
            } else {
                chartPlaceholder
            }

            if settings.showLimits {
                limitsSection
            }

            leaderboardSection

            Spacer(minLength: 0)

            footer
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
    }

    private var chartPlaceholder: some View {
        VStack(alignment: .leading, spacing: 7) {
            sectionLabel("Daily burn")
            HStack(spacing: 3) {
                ForEach(0..<14, id: \.self) { index in
                    Capsule()
                        .fill(Color.white.opacity(index == 13 ? 0.16 : 0.07))
                        .frame(maxWidth: .infinity)
                        .frame(height: CGFloat(5 + (index % 4) * 4))
                }
            }
            .frame(height: 44, alignment: .bottom)
            Text("Collecting the last 14 days…")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(height: 90, alignment: .top)
    }

    private var overview: some View {
        HStack(alignment: .top, spacing: 0) {
            metricColumn(
                label: "Today",
                value: model.summary.map { Formatters.compactTokens($0.today.totalTokens) } ?? "—",
                detail: model.summary.map { Formatters.usd($0.today.costUSD) } ?? "collecting"
            )
            divider
            metricColumn(
                label: "Last 7 days",
                value: model.summary.map { Formatters.compactTokens($0.week.totalTokens) } ?? "—",
                detail: model.summary.map { Formatters.usd($0.week.costUSD) } ?? "collecting"
            )
            divider
            metricColumn(
                label: "Streak",
                value: streakValue,
                detail: streakDetail,
                color: model.streakDays > 0 ? .orange : .secondary
            )
        }
        .frame(height: 62)
    }

    private var streakValue: String {
        guard model.summary != nil else { return "—" }
        return "\(model.streakDays)d"
    }

    private var streakDetail: String {
        guard model.summary != nil else { return "collecting" }
        if model.streakDays == 0 { return "start today" }
        if model.streakDays == 1 { return "active day" }
        return "active days"
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.09)).frame(width: 1).padding(.vertical, 5)
    }

    private func metricColumn(label: String, value: String, detail: String, color: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
                .tracking(0.5)
            Text(value)
                .font(.system(size: 21, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(color)
            Text(detail)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }

    @ViewBuilder
    private var limitsSection: some View {
        let limits = Array(model.providerLimits.prefix(3))
        VStack(alignment: .leading, spacing: 7) {
            sectionLabel("Limits")
            if limits.isEmpty {
                Text("Provider limits are still loading")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(limits) { provider in
                    let percent = provider.headline?.percent
                    HStack(spacing: 8) {
                        ProviderMark(id: provider.id, size: 15)
                        Text(provider.name).font(.callout.weight(.medium))
                        Text(provider.headline?.label ?? "usage")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(Formatters.percent(percent) ?? provider.headline?.note ?? "—")
                            .font(.callout.monospacedDigit().weight(.semibold))
                            .foregroundStyle(limitColor(percent, warn: settings.warnThreshold, critical: settings.criticalThreshold))
                    }
                    .frame(height: 24)
                }
            }
        }
    }

    @ViewBuilder
    private var leaderboardSection: some View {
        switch model.wbmState {
        case .ready(let profile):
            Button {
                if let url = WbmClient.profileURL() { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        sectionLabel("Today’s leaderboard")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.tertiary)
                    }

                    leaderboardSummary(profile)

                    VStack(spacing: 0) {
                        ForEach(Array(profile.leaderboardContext.prefix(5))) { row in
                            leaderboardRow(row, currentHandle: profile.handle)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        case .offline(let handle):
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel("Today’s leaderboard")
                HStack(spacing: 9) {
                    Image(systemName: "wifi.slash")
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Leaderboard unavailable")
                            .font(.callout.weight(.semibold))
                        Text("@\(handle) · your local usage is still updating")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(height: 46)
            }
        case .noAccount:
            Button {
                openLeaderboardHome()
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    sectionLabel("Today’s leaderboard")
                    HStack(spacing: 9) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connect your account")
                                .font(.callout.weight(.semibold))
                            Text("See your daily rank and today’s top burners")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(height: 46)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func leaderboardSummary(_ profile: WbmProfile) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Your rank")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Text(profile.dailyRank.map { "#\($0)" } ?? "—")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("@\(profile.handle)")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Rectangle()
                .fill(Color.white.opacity(0.09))
                .frame(width: 1, height: 47)
                .padding(.horizontal, 12)

            VStack(alignment: .leading, spacing: 2) {
                Text("Today’s leader")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Text(profile.dailyLeader.map { "@\($0.handle)" } ?? "No leader yet")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Text(profile.dailyLeader.map { Formatters.compactTokens($0.todayTokens) } ?? "0 tokens")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.orange)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 56)
    }

    private func leaderboardRow(_ row: WbmLeaderboardEntry, currentHandle: String) -> some View {
        let isCurrent = row.handle.caseInsensitiveCompare(currentHandle) == .orderedSame
        return HStack(spacing: 8) {
            Text("#\(row.rank)")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(row.rank == 1 ? .orange : .secondary)
                .frame(width: 27, alignment: .leading)
            Text("@\(row.handle)")
                .font(.system(size: 11, weight: isCurrent ? .bold : .medium, design: .rounded))
                .lineLimit(1)
            if isCurrent {
                Text("YOU")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.orange, in: Capsule())
            }
            Spacer(minLength: 6)
            Text(Formatters.compactTokens(row.todayTokens))
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(isCurrent ? .white : .secondary)
        }
        .frame(height: 22)
        .padding(.horizontal, 6)
        .background(isCurrent ? Color.white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
    }

    private func openLeaderboardHome() {
        let web = ProcessInfo.processInfo.environment["WHOBURNEDMORE_WEB"] ?? "https://whoburnedmore.com"
        if let url = URL(string: web) { NSWorkspace.shared.open(url) }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            Text("Local-first")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
            Spacer()
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
        .foregroundStyle(.secondary)
        .frame(height: 24)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.secondary)
            .tracking(0.6)
    }
}

private struct IslandBurnChart: View {
    let days: [DayPoint]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("14-DAY BURN")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .tracking(0.6)
                Spacer()
                Text("TOKENS / DAY")
                    .font(.system(size: 8, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }

            GeometryReader { geo in
                let maxTokens = max(days.map(\.tokens).max() ?? 1, 1)
                let gap: CGFloat = 3
                let width = max(2, (geo.size.width - gap * CGFloat(max(days.count - 1, 0))) / CGFloat(max(days.count, 1)))
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(days, id: \.date) { day in
                        VStack(spacing: 2) {
                            Text(Formatters.compactTokens(day.tokens))
                                .font(.system(size: 6, weight: .semibold, design: .monospaced))
                                .tracking(-0.25)
                                .foregroundStyle(day.date == days.last?.date ? Color.orange : Color.secondary)
                                .lineLimit(1)
                                .allowsTightening(true)
                                .minimumScaleFactor(0.65)
                                .frame(width: width)

                            ZStack(alignment: .bottom) {
                                Capsule()
                                    .fill(Color.white.opacity(0.045))
                                Capsule()
                                    .fill(day.date == days.last?.date ? Color.orange : Color.orange.opacity(0.31))
                                    .frame(height: max(3, 42 * CGFloat(day.tokens) / CGFloat(maxTokens)))
                            }
                            .frame(width: width, height: 42)

                            Text(String(day.date.suffix(2)))
                                .font(.system(size: 6.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        .help("\(day.date): \(day.tokens.formatted()) tokens")
                        .accessibilityLabel("\(day.date), \(day.tokens) tokens")
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .accessibilityLabel("14-day token burn")
    }
}

private struct IslandBackground: Shape {
    let hasNotch: Bool

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            topLeadingRadius: hasNotch ? 0 : 18,
            bottomLeadingRadius: 24,
            bottomTrailingRadius: 24,
            topTrailingRadius: hasNotch ? 0 : 18,
            style: .continuous
        ).path(in: rect)
    }
}

private enum BurnBarBrandIcon {
    static let image: NSImage = {
        guard let url = Bundle.main.url(forResource: "apple-icon", withExtension: "png"),
              let image = NSImage(contentsOf: url) else {
            return NSApplication.shared.applicationIconImage
        }
        return image
    }()
}
