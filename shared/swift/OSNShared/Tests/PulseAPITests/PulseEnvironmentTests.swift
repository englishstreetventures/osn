import Foundation
import OSNKit
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

// MARK: - Resolution from the build configuration

/// Pulse's asymmetry with `Environment`: **no Pulse API host is deployed at
/// any tier**, so only `local` has one to fall back on. Every other tier must
/// be told, and throws when it isn't — which is what stops a Release build
/// silently pointing at `http://localhost:3001`.
@Test func pulseResolveReadsLocalTier() throws {
    let env = try PulseEnvironment.resolve(info: .fixture(["OSNTier": "local"]))
    #expect(env == .local)
    #expect(env.baseURL == URL(string: "http://localhost:3001")!)
}

@Test func pulseResolveThrowsForProductionWithNoHostConfigured() {
    // This is the current state of the Release configuration in
    // pulse/ios/project.yml: PULSE_API_URL is deliberately empty, because
    // there is nothing to point it at yet.
    #expect(throws: OSNKitError.environmentURLMissing(key: "PulseAPIURL")) {
        try PulseEnvironment.resolve(info: .fixture(["OSNTier": "production"]))
    }
}

@Test func pulseResolveTakesTheSuppliedHostOnceThereIsOne() throws {
    let env = try PulseEnvironment.resolve(
        info: .fixture(["OSNTier": "production", "PulseAPIURL": "https://api.pulse.example"])
    )
    #expect(env.baseURL == URL(string: "https://api.pulse.example")!)
}

@Test func pulseResolveThrowsRatherThanDefaultingWhenTheTierIsAbsent() {
    #expect(throws: OSNKitError.deploymentTierMissing(key: "OSNTier")) {
        try PulseEnvironment.resolve(info: .fixture([:]))
    }
}
