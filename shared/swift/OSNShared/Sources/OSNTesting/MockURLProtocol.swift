import Foundation

/// A `URLProtocol` that answers every request from a handler you set, so a
/// test can drive a real `URLSession` (real cookie jar, real header handling)
/// without a network.
///
/// This is the one copy. Until it moved here it was duplicated, near enough
/// line for line, in five test files — `LoginMockURLProtocol`,
/// `MockURLProtocol`, `MiddlewareMockURLProtocol`, `MusubiMockURLProtocol` —
/// because a `URLProtocol` subclass is not shared across SPM test targets and
/// each target needed one. `OSNTesting` is a *source* target every test
/// target already depends on, which is the seam that was missing.
///
/// ## `handler` is global, and that is only safe because of the lock
///
/// One shared class means one shared `handler`, where five classes meant five.
/// Swift Testing runs suites — and whole test targets — concurrently, so this
/// would be a race if the suites using it could overlap.
///
/// They cannot: every suite that touches this mock also carries
/// `.keychainSerializing`, which serialises against every other test carrying
/// it across suites *and* targets. That covers `OSNAuthTests`'
/// `OSNSessionTests` and `PasskeyLoginClientTests`, `OSNKitTests`'
/// `KeychainSerialTests` (which `TokenRefresherTests` extends),
/// `PulseAPITests`' `BearerTokenMiddlewareTests`, and `MusubiFeatureTests`'
/// `FetchPasskeysTests`. They all drive HTTP that ends in a Keychain write, so
/// they needed the lock anyway and the mock rides along on it.
///
/// **If you use this mock from a new suite, give that suite
/// `.keychainSerializing` too** — even if it never touches the Keychain.
/// Without it the suite can run concurrently with another that is mid-request
/// and overwrite `handler` underneath it.
public final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    /// Answers one request. Set it synchronously before the call under test.
    public nonisolated(unsafe) static var handler: (
        @Sendable (URLRequest) async throws -> (Int, [String: String], Data)
    )?

    /// Where `Set-Cookie` headers are deposited.
    ///
    /// A custom `URLProtocol`'s `didReceive` callback does not run the real
    /// transport's `Set-Cookie` extraction — Foundation only populates
    /// `httpCookieStorage` for actual network responses. Point this at the
    /// test session's own cookie storage so the mock does that step by hand,
    /// matching what a genuine `/token` round trip would leave behind.
    /// `TokenRefresher` and `PasskeyLoginClient` both verify the rotated
    /// session cookie actually landed in the jar, so without this they fail
    /// against a mock that otherwise looks correct.
    public nonisolated(unsafe) static var cookieStorage: HTTPCookieStorage?

    override public class func canInit(with request: URLRequest) -> Bool { true }

    override public class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override public func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        Task {
            do {
                let (status, headers, data) = try await handler(request)
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                )!
                if let url = request.url {
                    let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
                    if !cookies.isEmpty {
                        Self.cookieStorage?.setCookies(cookies, for: url, mainDocumentURL: nil)
                    }
                }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override public func stopLoading() {}
}

/// An ephemeral `URLSession` wired to `MockURLProtocol`, with its cookie jar
/// registered so `Set-Cookie` in a mocked response lands where the code under
/// test looks for it.
public func makeMockSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    configuration.httpShouldSetCookies = true
    configuration.httpCookieAcceptPolicy = .always
    MockURLProtocol.cookieStorage = configuration.httpCookieStorage
    return URLSession(configuration: configuration)
}
