import AppKit
import SwiftUI

/// Verification aid: BURNBAR_SHOT_PATH=<file.png> renders the given SwiftUI
/// view to a PNG after BURNBAR_SHOT_DELAY seconds (default 10) via
/// ImageRenderer — no Screen Recording permission needed (`screencapture -l`
/// gets TCC-blocked) and, unlike NSView.cacheDisplay, text actually renders.
/// Never active without the env var.
@MainActor
enum WindowShot {
    static func arm<V: View>(envKey: String = "BURNBAR_SHOT_PATH", _ view: @escaping () -> V) {
        guard let path = ProcessInfo.processInfo.environment[envKey], !path.isEmpty else { return }
        let delay = Double(ProcessInfo.processInfo.environment["BURNBAR_SHOT_DELAY"] ?? "") ?? 10
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            shoot(view(), to: path)
        }
    }

    private static func shoot<V: View>(_ view: V, to path: String) {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .png, properties: [:]) else {
            print("shot-failed render")
            fflush(stdout)
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            print("shot-written \(path)")
        } catch {
            print("shot-failed \(error.localizedDescription)")
        }
        fflush(stdout)
    }
}
