import Foundation
import Observation

/// Drives the account screen: the profiles on the account, the email on it,
/// a copy of everything it holds, and the two buttons that end it.
///
/// Owns no client and no token — everything goes through `AccountAPI`.
@MainActor
@Observable
public final class AccountViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var profiles: [MusubiProfile] = []
    /// `nil` until the first load answers, and after a load where the
    /// profiles came back but the status call didn't.
    public private(set) var deletion: MusubiDeletionStatus?
    public private(set) var state: LoadState = .idle

    /// Which profile the app is signed in as, when it knows.
    ///
    /// It knows after a fresh sign-in (the login response names the profile)
    /// and after a switch it made itself. It does **not** know after a
    /// silent restore on launch: the restore round-trips a token, not a
    /// profile, and `/profiles/list` says nothing about which of them is the
    /// caller. `nil` means unknown, and the screen marks no row rather than
    /// guessing at the first one.
    public private(set) var currentProfileID: String?

    public private(set) var switchingID: String?
    public private(set) var makingDefaultID: String?
    /// A failed mutation, shown above the cards. Kept apart from
    /// `LoadState.failed` because the screen is still good — including when
    /// the user cancelled the Face ID sheet, which arrives here as an error
    /// like any other.
    public private(set) var mutationError: String?

    /// The address a code was sent to, held while waiting for the code back.
    /// Non-`nil` is what puts the screen in its second step.
    public private(set) var pendingEmail: String?
    public private(set) var isSendingCode = false
    public private(set) var isConfirmingEmail = false

    public private(set) var isRequestingDeletion = false
    public private(set) var isRestoring = false

    public private(set) var isExporting = false
    /// The bundle on disk, held only until the share sheet closes — see
    /// `dismissExport()`.
    public private(set) var exportURL: URL?

    public var currentProfile: MusubiProfile? {
        profiles.first { $0.id == currentProfileID }
    }

    /// One profile is the ordinary case, and switching is meaningless then.
    public var canSwitch: Bool { profiles.count > 1 }

    private let api: any AccountAPI
    /// Told when the app is now a different profile, so the rest of the shell
    /// stops showing the old one. Nothing to do with the API call, which has
    /// already stored the new token by the time this runs.
    private let onSwitch: (MusubiProfile) -> Void
    private var loadGeneration = 0

    public init(
        api: any AccountAPI,
        currentProfileID: String? = nil,
        onSwitch: @escaping (MusubiProfile) -> Void = { _ in }
    ) {
        self.api = api
        self.currentProfileID = currentProfileID
        self.onSwitch = onSwitch
    }

    /// Both reads at once: they are separate routes with nothing to say to
    /// each other.
    ///
    /// A failed deletion-status call does **not** fail the screen — the
    /// profiles are the screen, the banner is a banner. It does mean the
    /// banner stays down, which is the honest reading of "we don't know".
    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        async let profiles = api.listProfiles()
        async let deletion = api.deletionStatus()
        do {
            let loadedProfiles = try await profiles
            let loadedDeletion = try? await deletion
            guard generation == loadGeneration else { return }
            self.profiles = loadedProfiles
            self.deletion = loadedDeletion
            state = .loaded
        } catch {
            // A view that goes away cancels its load. That is the screen
            // closing, not a failure worth showing.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }

    /// Switching re-issues the access token, which `AccountAPI` stores. The
    /// list itself doesn't change — same account, same profiles — so this
    /// moves the marker and tells the shell, and doesn't re-read.
    public func switchProfile(id: String) async {
        guard id != currentProfileID else { return }
        switchingID = id
        mutationError = nil
        defer { switchingID = nil }
        do {
            let profile = try await api.switchProfile(id: id)
            currentProfileID = profile.id
            onSwitch(profile)
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Where the next sign-in lands. Deliberately not a switch: pressing it
    /// on the profile you aren't using should not move you there.
    public func makeDefault(id: String) async {
        makingDefaultID = id
        mutationError = nil
        defer { makingDefaultID = nil }
        do {
            _ = try await api.setDefaultProfile(id: id)
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Sends a code to the new address. Nothing on the account changes yet,
    /// and the screen says so — the swap happens in `confirmEmailChange`.
    ///
    /// A `sent: false` is not treated as success: no code arrived, so
    /// putting the user on the code screen would be a lie.
    public func beginEmailChange(to newEmail: String) async {
        isSendingCode = true
        mutationError = nil
        defer { isSendingCode = false }
        do {
            if try await api.beginEmailChange(to: newEmail) {
                pendingEmail = newEmail
            } else {
                mutationError = "The code didn't go out. Try again."
            }
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// The code proves the new address; the passkey ceremony inside the API
    /// proves the person. The swap also revokes the account's other
    /// sessions, so this device is the only one still signed in afterwards.
    public func confirmEmailChange(code: String) async {
        isConfirmingEmail = true
        mutationError = nil
        defer { isConfirmingEmail = false }
        do {
            _ = try await api.completeEmailChange(code: code)
            pendingEmail = nil
            // The address lives on the profile rows, so they are now stale.
            await load()
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Backs out of the code step without changing anything. The code the
    /// server sent simply goes unused.
    public func cancelEmailChange() {
        pendingEmail = nil
    }

    /// - Parameter confirmHandle: what the user typed. Sent verbatim; the
    ///   server compares it to the profile's handle and answers 400
    ///   `handle_mismatch` if it differs.
    public func requestDeletion(confirmHandle: String) async {
        isRequestingDeletion = true
        mutationError = nil
        defer { isRequestingDeletion = false }
        do {
            let schedule = try await api.requestDeletion(confirmHandle: confirmHandle)
            // Nothing is erased yet, so the screen stays and grows a banner
            // counting down to the moment it would be.
            deletion = .scheduled(scheduledFor: schedule.scheduledFor, softDeletedAt: Date())
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// `false` means nothing was pending — the window closed, or another
    /// device already restored. Either way this screen's idea of the state
    /// is stale, so it re-reads instead of claiming a rescue that didn't
    /// happen.
    public func restore() async {
        isRestoring = true
        mutationError = nil
        defer { isRestoring = false }
        do {
            if try await api.restore() {
                deletion = MusubiDeletionStatus.none
            } else {
                await load()
            }
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// One export per day per account, and the cap is only spent on a
    /// ceremony that succeeded — so a cancelled Face ID sheet costs nothing.
    public func exportAccount() async {
        isExporting = true
        mutationError = nil
        defer { isExporting = false }
        do {
            exportURL = try await api.exportAccount()
        } catch {
            guard !Task.isCancelled else { return }
            mutationError = String(describing: error)
        }
    }

    /// Deletes the bundle off disk. Called when the share sheet closes: the
    /// file is somebody's whole account in plaintext and has no business
    /// outliving the sheet that shared it.
    public func dismissExport() {
        if let exportURL {
            try? FileManager.default.removeItem(at: exportURL)
        }
        exportURL = nil
    }
}
