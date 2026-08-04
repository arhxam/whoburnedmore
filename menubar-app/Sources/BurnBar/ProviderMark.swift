import SwiftUI

/// Brand glyphs for each provider, drawn with Canvas so they render crisply at
/// any size (mirrors the approved web-mock marks). Used in the ring row and the
/// per-provider detail rows so the Limits section never reads as single-vendor.
struct ProviderMark: View {
    let id: String
    var size: CGFloat = 13

    static let color: [String: Color] = [
        "claude": Color(red: 0.85, green: 0.47, blue: 0.34),
        "codex": Color(white: 0.86),
        "cursor": Color(white: 0.83),
        "copilot": Color(red: 0.54, green: 0.82, blue: 0.63),
        "gemini": Color(red: 0.56, green: 0.61, blue: 1.0),
    ]

    var tint: Color { Self.color[id] ?? Color(white: 0.8) }

    var body: some View {
        Canvas { ctx, sz in
            let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
            let r = min(sz.width, sz.height) / 2
            switch id {
            case "claude":
                // 8-spoke starburst.
                for i in 0..<8 {
                    let a = Double(i) * .pi / 4
                    var p = Path(roundedRect: CGRect(x: -r * 0.11, y: -r, width: r * 0.22, height: r * 0.62),
                                 cornerRadius: r * 0.11)
                    p = p.applying(CGAffineTransform(rotationAngle: a))
                        .applying(CGAffineTransform(translationX: c.x, y: c.y))
                    ctx.fill(p, with: .color(tint))
                }
            case "gemini":
                // 4-point spark.
                var p = Path()
                let pts = [(0.0, -1.0), (0.32, -0.32), (1.0, 0.0), (0.32, 0.32),
                           (0.0, 1.0), (-0.32, 0.32), (-1.0, 0.0), (-0.32, -0.32)]
                for (i, pt) in pts.enumerated() {
                    let x = c.x + CGFloat(pt.0) * r, y = c.y + CGFloat(pt.1) * r
                    if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
                }
                p.closeSubpath()
                ctx.fill(p, with: .color(tint))
            case "codex", "cursor":
                // Hex/cube outline + inner spokes.
                var hex = Path()
                for i in 0..<6 {
                    let a = Double(i) * .pi / 3 - .pi / 2
                    let x = c.x + CGFloat(cos(a)) * r, y = c.y + CGFloat(sin(a)) * r
                    if i == 0 { hex.move(to: CGPoint(x: x, y: y)) } else { hex.addLine(to: CGPoint(x: x, y: y)) }
                }
                hex.closeSubpath()
                ctx.stroke(hex, with: .color(tint), lineWidth: r * 0.16)
                var inner = Path()
                inner.move(to: c); inner.addLine(to: CGPoint(x: c.x, y: c.y - r))
                inner.move(to: c); inner.addLine(to: CGPoint(x: c.x + r * 0.87, y: c.y + r * 0.5))
                inner.move(to: c); inner.addLine(to: CGPoint(x: c.x - r * 0.87, y: c.y + r * 0.5))
                ctx.stroke(inner, with: .color(tint.opacity(0.7)), lineWidth: r * 0.12)
            case "copilot":
                // Goggles: rounded bar + two eyes.
                let bar = Path(roundedRect: CGRect(x: c.x - r * 0.9, y: c.y - r * 0.2, width: r * 1.8, height: r * 1.0),
                               cornerRadius: r * 0.5)
                ctx.stroke(bar, with: .color(tint), lineWidth: r * 0.16)
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 0.55, y: c.y + r * 0.05, width: r * 0.34, height: r * 0.34)), with: .color(tint))
                ctx.fill(Path(ellipseIn: CGRect(x: c.x + r * 0.2, y: c.y + r * 0.05, width: r * 0.34, height: r * 0.34)), with: .color(tint))
            default:
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 0.5, y: c.y - r * 0.5, width: r, height: r)), with: .color(tint))
            }
        }
        .frame(width: size, height: size)
    }
}

/// Provider mark inside a rounded tile (used beside labels).
struct ProviderChip: View {
    let id: String
    var body: some View {
        ProviderMark(id: id, size: 13)
            .frame(width: 20, height: 20)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.07)))
    }
}

/// The BurnBar flame — the SAME glyph as the menu-bar icon (SF Symbol flame),
/// used everywhere instead of the 🔥 emoji.
struct BurnFlame: View {
    var size: CGFloat = 13
    var color: Color = .orange
    var body: some View {
        Image(systemName: "flame.fill")
            .font(.system(size: size))
            .foregroundStyle(color)
    }
}
