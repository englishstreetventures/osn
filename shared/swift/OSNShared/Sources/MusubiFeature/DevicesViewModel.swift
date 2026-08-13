import Foundation
import Observation

/// Drives the devices screen: lists the account's live sessions and revokes
/// them. Owns no `URLSession` and no token — it goes through `DevicesAPI`,
/// whose only real conformance is built on the client `MusubiSession`
/// assembles.
///
/// There is no pagination because the endpoint has none: sessions are
/// bounded per account and the route returns the lot.
@MainActor
@Observable
public final class DevicesViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var devices: [MusubiDevice] = []
    public private(set) var state: LoadState = .idle
    /// The row currently being revoked, so only its own button spins.
    public private(set) var revokingID: String?
    /// A failed revoke, shown next to the list. Kept apart from
    /// `LoadState.failed` because the list is still good when a revoke
    /// fails — replacing it with an error screen would throw away rows the
    /// user can still act on.
    public private(set) var revokeError: String?

    public var isEmpty: Bool { devices.isEmpty }

    private let api: any DevicesAPI
    /// Called when the app's own session stops being valid — i.e. the user
    /// revoked the session this app is running on. The view hands in
    /// `MusubiSession.signOut`.
    private let onSessionEnded: @MainActor () async -> Void
    private var loadGeneration = 0

    public init(
        api: any DevicesAPI,
        onSessionEnded: @escaping @MainActor () async -> Void
    ) {
        self.api = api
        self.onSessionEnded = onSessionEnded
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        do {
            let devices = try await api.listDevices()
            // A pull-to-refresh landing mid-request starts a newer load;
            // that one owns the list from here.
            guard generation == loadGeneration else { return }
            self.devices = devices.sortedForDisplay()
            state = .loaded
        } catch {
            // A view that goes away cancels its load. That is the screen
            // closing, not a failure worth showing.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }

    /// Revokes one session. The row is dropped locally on success rather
    /// than re-listing, so the list doesn't flash; a revoke of the current
    /// session ends the app's own session instead.
    public func revoke(id: String) async {
        revokingID = id
        revokeError = nil
        defer { revokingID = nil }
        do {
            if try await api.revokeDevice(id: id) {
                await onSessionEnded()
                return
            }
            devices.removeAll { $0.id == id }
        } catch {
            guard !Task.isCancelled else { return }
            revokeError = String(describing: error)
        }
    }

    /// Revokes every session except this one. Re-lists afterwards instead of
    /// filtering locally: the server decides what "other" means (a session
    /// created between the list and the call is included), so its answer is
    /// the only honest one.
    public func revokeAllOthers() async {
        revokeError = nil
        do {
            try await api.revokeOtherDevices()
            await load()
        } catch {
            guard !Task.isCancelled else { return }
            revokeError = String(describing: error)
        }
    }
}
