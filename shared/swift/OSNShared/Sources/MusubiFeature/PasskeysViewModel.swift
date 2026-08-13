import Foundation
import Observation

/// Drives the passkeys screen: lists the account's credentials, renames,
/// deletes and enrols. Owns no client and no token — everything goes through
/// `PasskeysAPI`.
///
/// Each mutation re-lists rather than patching the array. That is the
/// opposite of `DevicesViewModel`, on purpose: a rename changes a field the
/// server owns, an enrolment adds a row the client can't describe (it never
/// sees the new credential's flags), and both have just cost the user a
/// biometric prompt — a round trip is cheap next to that, and guessing is
/// how a list starts lying.
@MainActor
@Observable
public final class PasskeysViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var passkeys: [MusubiPasskey] = []
    public private(set) var state: LoadState = .idle
    /// The row being renamed or deleted, so only its own controls spin.
    public private(set) var mutatingID: String?
    /// True while an enrolment ceremony is in flight.
    public private(set) var isAdding = false
    /// A failed mutation, shown above the list. Kept apart from
    /// `LoadState.failed` because the list is still good — including when
    /// the user simply cancelled the passkey sheet, which arrives here as an
    /// error like any other.
    public private(set) var mutationError: String?

    public var isEmpty: Bool { passkeys.isEmpty }

    /// The account invariant is at least one passkey, and the server
    /// enforces it. The screen shows the last one as undeletable rather than
    /// letting the user spend a biometric prompt on a call that will be
    /// refused.
    public var canDelete: Bool { passkeys.count > 1 }

    private let api: any PasskeysAPI
    private var loadGeneration = 0

    public init(api: any PasskeysAPI) {
        self.api = api
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        do {
            let passkeys = try await api.listPasskeys()
            // A pull-to-refresh landing mid-request starts a newer load;
            // that one owns the list from here.
            guard generation == loadGeneration else { return }
            self.passkeys = passkeys.sortedForDisplay()
            state = .loaded
        } catch {
            // A view that goes away cancels its load. That is the screen
            // closing, not a failure worth showing.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }

    public func rename(id: String, label: String) async {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await mutate(id: id) {
            try await self.api.renamePasskey(id: id, label: trimmed)
            // `PATCH /passkeys/:id` answers `{ "success": true }` and not the
            // updated summary, so the new label comes back the only way it
            // can.
            await self.load()
        }
    }

    /// Drops the row on success and trusts `remaining` over its own count:
    /// the server has just told us how many are left, and a passkey enrolled
    /// on another device since the last list would make a local count wrong.
    public func delete(id: String) async {
        await mutate(id: id) {
            let remaining = try await self.api.deletePasskey(id: id)
            self.passkeys.removeAll { $0.id == id }
            // Only worth re-listing when the two disagree — something
            // changed elsewhere and this list is already stale.
            if remaining != self.passkeys.count {
                await self.load()
            }
        }
    }

    public func add() async {
        isAdding = true
        mutationError = nil
        defer { isAdding = false }
        do {
            try await api.addPasskey()
            await load()
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    private func mutate(id: String, _ body: () async throws -> Void) async {
        mutatingID = id
        mutationError = nil
        defer { mutatingID = nil }
        do {
            try await body()
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }
}
