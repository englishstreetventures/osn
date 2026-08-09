import Foundation
import Testing
@testable import PulseAPI

@Test func localResolvesToLocalhostPort3001() {
    #expect(PulseEnvironment.local.baseURL == URL(string: "http://localhost:3001")!)
}

@Test func devPassesThroughCallerSuppliedURL() {
    let url = URL(string: "https://dev.example.internal")!
    #expect(PulseEnvironment.dev(baseURL: url).baseURL == url)
}

@Test func stagingPassesThroughCallerSuppliedURL() {
    let url = URL(string: "https://staging.example.internal")!
    #expect(PulseEnvironment.staging(baseURL: url).baseURL == url)
}

@Test func productionPassesThroughCallerSuppliedURL() {
    let url = URL(string: "https://production.example.internal")!
    #expect(PulseEnvironment.production(baseURL: url).baseURL == url)
}
