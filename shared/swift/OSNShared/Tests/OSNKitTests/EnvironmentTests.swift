import Foundation
import Testing
@testable import OSNKit

@Test func localResolvesToLocalhost() {
    #expect(Environment.local.baseURL == URL(string: "http://localhost:4000")!)
}

@Test func productionResolvesToMusubiSocial() {
    #expect(Environment.production.baseURL == URL(string: "https://id.musubi.social")!)
}

@Test func devPassesThroughCallerSuppliedURL() {
    let url = URL(string: "https://dev.example.internal")!
    #expect(Environment.dev(baseURL: url).baseURL == url)
}

@Test func stagingPassesThroughCallerSuppliedURL() {
    let url = URL(string: "https://staging.example.internal")!
    #expect(Environment.staging(baseURL: url).baseURL == url)
}
