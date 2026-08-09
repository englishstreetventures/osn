import Foundation
import Testing
@testable import OSNKit

@Test func localCookieNameHasNoHostPrefix() {
    #expect(sessionCookieName(for: .local) == "osn_session")
}

@Test func productionCookieNameHasHostPrefix() {
    #expect(sessionCookieName(for: .production) == "__Host-osn_session")
}

@Test func devCookieNameHasHostPrefix() {
    #expect(sessionCookieName(for: .dev(baseURL: URL(string: "https://dev.example.internal")!)) == "__Host-osn_session")
}

@Test func stagingCookieNameHasHostPrefix() {
    #expect(sessionCookieName(for: .staging(baseURL: URL(string: "https://staging.example.internal")!)) == "__Host-osn_session")
}
