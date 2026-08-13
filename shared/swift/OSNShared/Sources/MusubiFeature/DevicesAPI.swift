import Foundation
import OSNAPI

/// The three calls the devices screen makes, named in its own terms.
///
/// `DevicesViewModel` takes this rather than the whole generated
/// `APIProtocol` for one practical reason: `APIProtocol` has 73 methods, so
/// a test double for it would be 73 stubs to exercise three. The real
/// conformance below is the only place the generated shapes are unwrapped.
public protocol DevicesAPI: Sendable {
    func listDevices() async throws -> [MusubiDevice]
    /// - Returns: the server's `revokedSelf` — true when the revoked
    ///   session was the one making the call. Reported, never inferred from
    ///   the id: the caller's session is whatever the server says it is.
    func revokeDevice(id: String) async throws -> Bool
    func revokeOtherDevices() async throws
}

/// `DevicesAPI` over the generated osn-api client.
public struct OSNDevicesAPI: DevicesAPI {
    private let client: any APIProtocol

    public init(client: any APIProtocol) {
        self.client = client
    }

    public func listDevices() async throws -> [MusubiDevice] {
        try await client.listSessions(.init()).ok.body.json.sessions.map(MusubiDevice.init)
    }

    public func revokeDevice(id: String) async throws -> Bool {
        try await client.revokeSession(.init(path: .init(id: id))).ok.body.json.revokedSelf
    }

    public func revokeOtherDevices() async throws {
        _ = try await client.revokeAllOtherSessions(.init()).ok.body.json
    }
}
