import BurnBarCore
import Foundation
import os

/// Owns the burnbar-sidecar child process: spawn `watch`, stream NDJSON events,
/// restart with backoff if it dies. All callbacks hop to the main actor.
@MainActor
final class SidecarClient {
    private let log = Logger(subsystem: "com.whoburnedmore.burnbar", category: "sidecar")
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var restartDelay: TimeInterval = 1
    private var stopped = false
    var onEvent: ((SidecarEvent) -> Void)?

    /// Sidecar binary: env override (dev) → app Resources.
    static func sidecarURL() -> URL? {
        if let override = ProcessInfo.processInfo.environment["BURNBAR_SIDECAR"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return Bundle.main.resourceURL?.appendingPathComponent("burnbar-sidecar")
    }

    static func ccusageURL() -> URL? {
        if let override = ProcessInfo.processInfo.environment["BURNBAR_CCUSAGE"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return Bundle.main.resourceURL?.appendingPathComponent("ccusage")
    }

    func start() {
        stopped = false
        launch()
    }

    func stop() {
        stopped = true
        try? stdinPipe?.fileHandleForWriting.write(contentsOf: Data("{\"cmd\":\"quit\"}\n".utf8))
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil // tear down the dispatch source
        process?.terminate()
        process = nil
        stdinPipe = nil
        stdoutPipe = nil
    }

    func requestRefresh() {
        try? stdinPipe?.fileHandleForWriting.write(contentsOf: Data("{\"cmd\":\"refresh\"}\n".utf8))
    }

    private func launch() {
        guard let bin = Self.sidecarURL(), FileManager.default.isExecutableFile(atPath: bin.path) else {
            log.error("sidecar binary missing")
            return
        }
        let p = Process()
        p.executableURL = bin
        p.arguments = ["watch"]
        var env = ProcessInfo.processInfo.environment
        if let ccusage = Self.ccusageURL(), FileManager.default.isExecutableFile(atPath: ccusage.path) {
            env["BURNBAR_CCUSAGE"] = ccusage.path
        }
        p.environment = env

        let stdout = Pipe()
        let stdin = Pipe()
        p.standardOutput = stdout
        p.standardInput = stdin
        p.standardError = FileHandle.nullDevice

        var buffer = Data()
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                let lineData = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let line = String(data: Data(lineData), encoding: .utf8),
                      let event = SidecarEvent.parse(line: line) else { continue }
                Task { @MainActor [weak self] in
                    self?.restartDelay = 1
                    self?.onEvent?(event)
                }
            }
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else { return }
                self.log.warning("sidecar exited — restarting in \(self.restartDelay, format: .fixed(precision: 0))s")
                let delay = self.restartDelay
                self.restartDelay = min(delay * 2, 60)
                try? await Task.sleep(for: .seconds(delay))
                if !self.stopped { self.launch() }
            }
        }

        do {
            try p.run()
            process = p
            stdinPipe = stdin
            stdoutPipe = stdout
            log.info("sidecar started pid \(p.processIdentifier)")
        } catch {
            log.error("sidecar spawn failed: \(error.localizedDescription)")
        }
    }
}
