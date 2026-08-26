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

// MARK: - Resolution from the build configuration
//
// Every branch below is reachable only because `resolve` takes an
// `InfoDictionaryLookup` rather than a `Bundle` — a test cannot build a
// `Bundle` with an arbitrary info dictionary. Same seam, same reason, as
// `SharedCookieJar.makeConfiguration`'s `containerURLProvider`.

@Test func resolveReadsLocalTier() throws {
    let env = try Environment.resolve(info: .fixture(["OSNTier": "local"]))
    #expect(env == .local)
}

@Test func resolveReadsProductionTierWithoutNeedingAURL() throws {
    // `production` has a fixed host, so a build that supplies no OSNIssuerURL
    // still resolves — this is what a Release build of either app does.
    let env = try Environment.resolve(info: .fixture(["OSNTier": "production"]))
    #expect(env == .production)
    #expect(env.baseURL == URL(string: "https://id.musubi.social")!)
}

@Test func resolveTakesTheSuppliedHostForDevAndStaging() throws {
    let dev = try Environment.resolve(
        info: .fixture(["OSNTier": "dev", "OSNIssuerURL": "https://id.dev.musubi.social"])
    )
    #expect(dev.baseURL == URL(string: "https://id.dev.musubi.social")!)

    let staging = try Environment.resolve(
        info: .fixture(["OSNTier": "staging", "OSNIssuerURL": "https://id.staging.musubi.social"])
    )
    #expect(staging.baseURL == URL(string: "https://id.staging.musubi.social")!)
}

/// The whole point of the type: no tier means no guess. A silent `.local`
/// fallback here is what shipped a release pointing at localhost.
@Test func resolveThrowsRatherThanDefaultingWhenTheTierIsAbsent() {
    #expect(throws: OSNKitError.deploymentTierMissing(key: "OSNTier")) {
        try Environment.resolve(info: .fixture([:]))
    }
}

@Test func resolveThrowsOnAnEmptyTier() {
    // An unset xcconfig variable expands to the empty string, not to nothing —
    // so this is the shape a missing build setting actually takes.
    #expect(throws: OSNKitError.deploymentTierMissing(key: "OSNTier")) {
        try Environment.resolve(info: .fixture(["OSNTier": ""]))
    }
}

@Test func resolveThrowsOnAnUnknownTier() {
    #expect(throws: OSNKitError.deploymentTierUnknown(value: "prod")) {
        try Environment.resolve(info: .fixture(["OSNTier": "prod"]))
    }
}

@Test func resolveThrowsWhenADevBuildSuppliesNoIssuerHost() {
    #expect(throws: OSNKitError.environmentURLMissing(key: "OSNIssuerURL")) {
        try Environment.resolve(info: .fixture(["OSNTier": "dev"]))
    }
}

@Test func resolveThrowsOnAHostThatIsNotAnAbsoluteURL() {
    #expect(throws: OSNKitError.environmentURLInvalid(key: "OSNIssuerURL", value: "id.musubi.social")) {
        try Environment.resolve(info: .fixture(["OSNTier": "dev", "OSNIssuerURL": "id.musubi.social"]))
    }
}

@Test func everyTierNameRoundTrips() {
    // Guards the strings in both project.yml files against a rename here.
    #expect(DeploymentTier.allCases.map(\.rawValue) == ["local", "dev", "staging", "production"])
}
