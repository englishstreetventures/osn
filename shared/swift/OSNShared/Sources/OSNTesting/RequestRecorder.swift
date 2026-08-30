import Foundation

/// A `MockURLProtocol` handler is `@Sendable`, so a plain captured `var` is a
/// data race under strict concurrency even where every call is sequential.
/// Route the capture through an actor instead.
public actor Recorder<Value: Sendable> {
    public private(set) var values: [Value] = []

    public init() {}

    public func record(_ value: Value) { values.append(value) }
    public var count: Int { values.count }
    public var last: Value? { values.last }
}

/// One request as a test sees it: the path plus the two headers the
/// authenticated-transport suites assert on. Kept here rather than in one
/// test file because three test files need it, and a `URLProtocol` fixture
/// does not cross SPM test targets — the same reason `MockURLProtocol` lives
/// in this target.
public struct SeenRequest: Sendable, Equatable {
    public let path: String
    public let authorization: String?
    public let stepUpToken: String?
    public let body: Data?

    public init(_ request: URLRequest) {
        self.path = request.url?.path ?? ""
        self.authorization = request.value(forHTTPHeaderField: "Authorization")
        self.stepUpToken = request.value(forHTTPHeaderField: "X-Step-Up-Token")
        // `URLProtocol` strips `httpBody` off the request it hands the
        // subclass and exposes it as a stream instead, so read it back from
        // there — otherwise every recorded body is `nil`.
        self.body = request.httpBody ?? request.httpBodyStream.map(Self.drain)
    }

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

public func record(_ request: URLRequest, into recorder: Recorder<SeenRequest>) async {
    await recorder.record(SeenRequest(request))
}
