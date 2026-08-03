import BurnBarCore
import Foundation
import UserNotifications
import os

/// Threshold/reset notifications. Permission is requested lazily; delivery is
/// best-effort (the popover shows the same state regardless).
@MainActor
final class Notifier {
    private let log = Logger(subsystem: "com.whoburnedmore.burnbar", category: "notify")

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func deliver(provider: String, kind: String, level: Int?, percent: Double) {
        let content = UNMutableNotificationContent()
        switch kind {
        case "reset":
            content.title = "\(provider) window reset"
            content.body = "You're back — usage is at \(Int(percent.rounded()))%."
        default:
            content.title = "\(provider) at \(Int(percent.rounded()))% of its limit"
            content.body = level == 95
                ? "Nearly locked out — consider pausing or switching tools."
                : "Heads up: you've crossed \(level ?? 80)% of the window."
        }
        content.sound = level == 95 ? .default : nil
        let request = UNNotificationRequest(
            identifier: "burnbar-\(provider)-\(kind)-\(level ?? 0)-\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { [log] error in
            if let error { log.warning("notification failed: \(error.localizedDescription)") }
        }
    }

    func deliverForecast(provider: String, hitAt: Date) {
        let content = UNMutableNotificationContent()
        content.title = "\(provider): cap in sight"
        content.body = "At this pace you hit the limit around \(hitAt.formatted(date: .omitted, time: .shortened)). Good moment to wrap up or switch tools."
        push(content, id: "forecast-\(provider)")
    }

    func deliverOvertaken(newRank: Int) {
        let content = UNMutableNotificationContent()
        content.title = "You've been overtaken 🏃"
        content.body = "You're now #\(newRank) on today's whoburnedmore board."
        push(content, id: "overtaken-\(newRank)")
    }

    func deliverDigest(tokens: Int, costUSD: Double, dailyRank: Int?) {
        let content = UNMutableNotificationContent()
        content.title = "Today's burn: \(Formatters.compactTokens(tokens))"
        content.body = dailyRank.map { "\(Formatters.usd(costUSD)) · #\($0) on today's board." }
            ?? "\(Formatters.usd(costUSD)) across your tools."
        push(content, id: "digest")
    }

    private func push(_ content: UNMutableNotificationContent, id: String) {
        let request = UNNotificationRequest(
            identifier: "burnbar-\(id)-\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { [log] error in
            if let error { log.warning("notification failed: \(error.localizedDescription)") }
        }
    }
}
