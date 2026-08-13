import Foundation
import Observation

/// Drives the security screen: the unacknowledged event feed, and the
/// recovery-code counts sitting above it. Owns no client and no token —
/// everything goes through `SecurityAPI`.
@MainActor
@Observable
public final class SecurityViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var events: [MusubiSecurityEvent] = []
    /// `nil` until the first load answers, and after a load where the events
    /// came back but the status call didn't.
    public private(set) var recovery: MusubiRecoveryStatus?
    public private(set) var state: LoadState = .idle
    /// The row being acknowledged, so only its own button spins.
    public private(set) var acknowledgingID: String?
    public private(set) var isAcknowledgingAll = false
    public private(set) var isGenerating = false
    /// A failed mutation, shown above the feed. Kept apart from
    /// `LoadState.failed` because the feed is still good — including when
    /// the user simply cancelled the Face ID sheet, which arrives here as an
    /// error like any other.
    public private(set) var mutationError: String?
    /// A set of codes just minted, held only until the user dismisses them.
    /// The server keeps hashes, so this is the one and only time they exist
    /// anywhere the user can read them — and the reason they are never
    /// written to disk.
    public private(set) var freshCodes: [String]?

    public var isEmpty: Bool { events.isEmpty }

    private let api: any SecurityAPI
    private var loadGeneration = 0

    public init(api: any SecurityAPI) {
        self.api = api
    }

    /// Both reads at once: they are separate routes with nothing to say to
    /// each other, and the screen shows them together.
    ///
    /// A failed status call does **not** fail the screen. The feed is the
    /// point, the counts are a header, and blanking the first because the
    /// second timed out would hide exactly what the user came to read.
    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        async let events = api.listSecurityEvents()
        async let recovery = api.recoveryStatus()
        do {
            let loadedEvents = try await events
            let loadedRecovery = try? await recovery
            // A pull-to-refresh landing mid-request starts a newer load;
            // that one owns the screen from here.
            guard generation == loadGeneration else { return }
            self.events = loadedEvents.sortedForDisplay()
            self.recovery = loadedRecovery
            state = .loaded
        } catch {
            // A view that goes away cancels its load. That is the screen
            // closing, not a failure worth showing.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }

    /// Drops the row on a `true`. A `false` means the server had nothing
    /// unacknowledged under that id — someone acknowledged it on another
    /// device — so the list is stale and re-listing is the honest fix.
    public func acknowledge(id: String) async {
        acknowledgingID = id
        mutationError = nil
        defer { acknowledgingID = nil }
        do {
            if try await api.acknowledgeEvent(id: id) {
                events.removeAll { $0.id == id }
            } else {
                await load()
            }
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// One ceremony clears the feed. The server acknowledges everything
    /// unacknowledged *at that moment*, so its count is trusted over the
    /// local one: if they disagree, an event arrived or left while the
    /// ceremony was on screen and this list is already behind.
    public func acknowledgeAll() async {
        isAcknowledgingAll = true
        mutationError = nil
        defer { isAcknowledgingAll = false }
        do {
            let acknowledged = try await api.acknowledgeAllEvents()
            if acknowledged == events.count {
                events.removeAll()
            } else {
                await load()
            }
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Makes a new set of ten and holds them for the sheet.
    ///
    /// Reloads afterwards for two reasons, not one: the counts change, and
    /// generating **writes a security event of its own**
    /// (`recovery_code_generate`), so the feed the user is looking at is now
    /// short a row.
    public func generateRecoveryCodes() async {
        isGenerating = true
        mutationError = nil
        defer { isGenerating = false }
        do {
            freshCodes = try await api.generateRecoveryCodes()
            await load()
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Forgets the plaintext codes. Called when the sheet closes — after
    /// this nothing can show them again, which is the contract, not a bug.
    public func dismissCodes() {
        freshCodes = nil
    }
}
