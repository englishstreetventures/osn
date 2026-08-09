import Foundation
import Testing
@testable import OSNKit

// An unsandboxed `swift test` host process can resolve an App Group
// container path even without the entitlement, so asserting on the real
// `FileManager` result isn't reliable here. `containerURLProvider` lets the
// test force the unavailable branch the same way an unprovisioned device
// build would hit it.
@Test func makeConfigurationThrowsWhenAppGroupContainerUnavailable() {
    #expect(throws: OSNKitError.appGroupContainerUnavailable(groupIdentifier: osnSessionAppGroupIdentifier)) {
        try SharedCookieJar.makeConfiguration(containerURLProvider: { _ in nil })
    }
}

@Test func makeConfigurationReportsTheGroupIdentifierItChecked() {
    let groupIdentifier = "group.does.not.exist"
    #expect(throws: OSNKitError.appGroupContainerUnavailable(groupIdentifier: groupIdentifier)) {
        try SharedCookieJar.makeConfiguration(groupIdentifier: groupIdentifier, containerURLProvider: { _ in nil })
    }
}

@Test func makeConfigurationSucceedsWhenContainerResolves() throws {
    let configuration = try SharedCookieJar.makeConfiguration(containerURLProvider: { _ in URL(fileURLWithPath: "/tmp") })
    #expect(configuration.httpShouldSetCookies)
    #expect(configuration.httpCookieAcceptPolicy == .always)
}
