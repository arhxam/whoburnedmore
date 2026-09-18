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
    private var restartTask: Task<Void, Never>?
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
        guard stopped || (process == nil && restartTask == nil) else { return }
        stopped = false
        launch()
    }

    func stop() {
        stopped = true
        restartTask?.cancel()
        restartTask = nil
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
        guard !stopped, process == nil else { return }
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

        let framer = OSAllocatedUnfairLock(initialState: BoundedNDJSONFramer())
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            do {
                let lines = try framer.withLock { state in
                    try state.append(handle.availableData)
                }
                for line in lines {
                    guard let event = SidecarEvent.parse(line: line) else { continue }
                    Task { @MainActor [weak self, weak p] in
                        guard let self, let p, self.process === p, !self.stopped else { return }
                        self.restartDelay = 1
                        self.onEvent?(event)
                    }
                }
            } catch {
                Task { @MainActor [weak self, weak p] in
                    guard let self, let p, self.process === p else { return }
                    self.log.error("sidecar protocol frame exceeded 1 MiB — restarting")
                    stdout.fileHandleForReading.readabilityHandler = nil
                    p.terminate()
                }
            }
        }
        p.terminationHandler = { [weak self] finished in
            Task { @MainActor [weak self] in
                guard let self, self.process === finished else { return }
                self.stdoutPipe?.fileHandleForReading.readabilityHandler = nil
                self.process = nil
                self.stdinPipe = nil
                self.stdoutPipe = nil
                self.scheduleRestart()
            }
        }

        do {
            try p.run()
            process = p
            stdinPipe = stdin
            stdoutPipe = stdout
            log.info("sidecar started pid \(p.processIdentifier)")
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            log.error("sidecar spawn failed: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        guard !stopped, restartTask == nil else { return }
        log.warning("sidecar exited — restarting in \(self.restartDelay, format: .fixed(precision: 0))s")
        let delay = restartDelay
        restartDelay = min(delay * 2, 60)
        restartTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
            guard let self, !self.stopped else { return }
            self.restartTask = nil
            self.launch()
        }
    }
}
