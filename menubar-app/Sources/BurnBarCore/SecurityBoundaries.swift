import Foundation

public enum TrustedWebURL {
    /// Normalize an outbound service base to an origin. Production services
    /// require TLS; plaintext is permitted only for explicit loopback dev.
    public static func serviceOrigin(_ candidate: String) -> URL? {
        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        let localHost = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && localHost) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url
    }

    /// Validate a server-returned device-flow URL against the independently
    /// configured website origin before handing it to macOS URL dispatch.
    public static func deviceVerification(_ candidate: String, allowedBase: URL) -> URL? {
        guard let allowedScheme = allowedBase.scheme?.lowercased(),
              let allowedHost = allowedBase.host?.lowercased(),
              allowedBase.user == nil,
              allowedBase.password == nil else { return nil }
        let localHost = allowedHost == "localhost" || allowedHost == "127.0.0.1" || allowedHost == "::1"
        guard allowedScheme == "https" || (allowedScheme == "http" && localHost),
              let url = URL(string: candidate),
              url.scheme?.lowercased() == allowedScheme,
              url.host?.lowercased() == allowedHost,
              url.user == nil,
              url.password == nil,
              effectivePort(url) == effectivePort(allowedBase) else { return nil }
        return url
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }
}

public enum BoundedHTTPError: Error, Equatable {
    case responseTooLarge
    case nonHTTPResponse
}

public struct BoundedDataAccumulator {
    public let maxBytes: Int
    public private(set) var data = Data()

    public init(maxBytes: Int) {
        self.maxBytes = max(1, maxBytes)
        data.reserveCapacity(min(self.maxBytes, 64 * 1024))
    }

    public mutating func append(_ byte: UInt8) throws {
        guard data.count < maxBytes else { throw BoundedHTTPError.responseTooLarge }
        data.append(byte)
    }
}

public enum BoundedHTTP {
    /// Stream one HTTP response with an enforced cumulative byte ceiling. The
    /// underlying task is cancelled when parsing exits early.
    public static func data(
        for request: URLRequest,
        maxBytes: Int,
        session: URLSession = .shared
    ) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else {
            throw BoundedHTTPError.nonHTTPResponse
        }
        if response.expectedContentLength > Int64(max(1, maxBytes)) {
            throw BoundedHTTPError.responseTooLarge
        }
        var accumulator = BoundedDataAccumulator(maxBytes: maxBytes)
        for try await byte in bytes {
            try accumulator.append(byte)
        }
        return (accumulator.data, http)
    }
}

public struct BoundedNDJSONFramer {
    public enum FramingError: Error, Equatable {
        case frameTooLarge
    }

    private var pending = Data()
    public let maxFrameBytes: Int

    public init(maxFrameBytes: Int = 1_048_576) {
        self.maxFrameBytes = max(1, maxFrameBytes)
    }

    public var pendingByteCount: Int { pending.count }

    public mutating func append(_ chunk: Data) throws -> [String] {
        pending.append(chunk)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
            let length = pending.distance(from: pending.startIndex, to: newline)
            guard length <= maxFrameBytes else {
                pending.removeAll(keepingCapacity: false)
                throw FramingError.frameTooLarge
            }
            let lineData = pending[pending.startIndex..<newline]
            pending.removeSubrange(pending.startIndex...newline)
            if let line = String(data: Data(lineData), encoding: .utf8) {
                lines.append(line)
            }
        }
        guard pending.count <= maxFrameBytes else {
            pending.removeAll(keepingCapacity: false)
            throw FramingError.frameTooLarge
        }
        return lines
    }
}
