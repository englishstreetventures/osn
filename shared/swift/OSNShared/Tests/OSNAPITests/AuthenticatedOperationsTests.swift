import Foundation
import Testing

@testable import OSNAPI

/// The middleware's auth policy is a checked-in copy of what
/// `shared/openapi/osn.json` declares. A copy that drifts is worse than no
/// copy: a route that gains an auth gate would go on being called with no
/// `Authorization` header, and the app would read the 401 as "signed out".
/// So compare the two here rather than trusting the generator ran.
struct AuthenticatedOperationsTests {
    /// The spec lives outside the package, so there is no bundle to read it
    /// from — walk up from this file instead. `swift test` only ever runs
    /// inside the repo, which is the only place the check means anything.
    private static var specURL: URL {
        var url = URL(fileURLWithPath: #filePath)
        // …/shared/swift/OSNShared/Tests/OSNAPITests/<this file> — six hops
        // up is the repo root.
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("shared/openapi/osn.json")
    }

    private static func operationIDs(requiringAuth: Bool) throws -> Set<String> {
        let data = try Data(contentsOf: specURL)
        let spec = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let paths = spec["paths"] as! [String: [String: Any]]
        let methods: Set<String> = ["get", "put", "post", "delete", "patch", "options", "head", "trace"]

        var ids: Set<String> = []
        for (_, pathItem) in paths {
            for (method, operation) in pathItem where methods.contains(method) {
                guard let operation = operation as? [String: Any] else { continue }
                // `security: []` means "explicitly public", so an empty array
                // counts as no requirement — the same rule the generator uses.
                let secured = (operation["security"] as? [Any])?.isEmpty == false
                guard secured == requiringAuth else { continue }
                ids.insert(operation["operationId"] as! String)
            }
        }
        return ids
    }

    @Test func matchesTheSpecExactly() throws {
        let fromSpec = try Self.operationIDs(requiringAuth: true)
        let checkedIn = OSNAuthenticatedOperations.operationIDs

        // Report both directions by name: a missing ID sends an anonymous
        // request to a gated route, an extra one forces a doomed `/token`
        // call in front of a public route.
        #expect(
            fromSpec.subtracting(checkedIn).isEmpty,
            "Spec requires auth for operations the checked-in file omits — run bun run scripts/generate-osn-authenticated-operations.ts"
        )
        #expect(
            checkedIn.subtracting(fromSpec).isEmpty,
            "Checked-in file requires auth for operations the spec no longer gates — run bun run scripts/generate-osn-authenticated-operations.ts"
        )
    }

    /// The ceremonies a signed-out app has to be able to run. Named one by
    /// one because these are the operations where a stray `Authorization`
    /// header costs a user their sign-in, not just a wasted request.
    @Test(arguments: [
        "beginRegistration",
        "completeRegistration",
        "beginPasskeyLogin",
        "completePasskeyLogin",
        "completeRecoveryLogin",
        "refreshSession",
        "logout",
        "getJwks",
        "getOpenIdConfiguration",
        "checkHandleAvailability",
    ])
    func signedOutOperationsCarryNoToken(operationID: String) throws {
        #expect(OSNAuthenticatedOperations.requiresAuthentication(operationID) == false)
        #expect(try Self.operationIDs(requiringAuth: false).contains(operationID))
    }

    @Test func authenticatedOperationsAreRecognised() {
        #expect(OSNAuthenticatedOperations.requiresAuthentication("listSessions"))
        #expect(OSNAuthenticatedOperations.requiresAuthentication("requestAccountDeletion"))
        // An operation ID this client has never heard of gets no token, which
        // is the safe default: a spurious header can leak a token to a route
        // that never asked for one.
        #expect(OSNAuthenticatedOperations.requiresAuthentication("notAnOperation") == false)
    }
}
