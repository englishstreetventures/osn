import Foundation
import OSNAPI
import Testing
@testable import MusubiFeature

private func makeProfile(id: String, handle: String = "ada", email: String = "ada@example.com") -> MusubiProfile {
    MusubiProfile(id: id, handle: handle, email: email, displayName: nil, avatarUrl: nil)
}

private struct StubError: Error, CustomStringConvertible {
    let description = "stub failed"
}

/// Scripted `AccountAPI`. `@MainActor` because four of the nine methods run
/// a passkey ceremony in the real conformance and are declared on the main
/// actor there.
@MainActor
private final class StubAccountAPI: AccountAPI {
    var listResults: [Result<[MusubiProfile], Error>]
    var statusResults: [Result<MusubiDeletionStatus, Error>]
    var switchResults: [Result<MusubiProfile, Error>]
    var defaultResults: [Result<MusubiProfile, Error>]
    var beginEmailResults: [Result<Bool, Error>]
    var completeEmailResults: [Result<String, Error>]
    var deletionResults: [Result<MusubiDeletionSchedule, Error>]
    var restoreResults: [Result<Bool, Error>]
    var exportResults: [Result<URL, Error>]
    private(set) var listCount = 0
    private(set) var switchedIDs: [String] = []
    private(set) var defaultedIDs: [String] = []
    private(set) var begunEmails: [String] = []
    private(set) var submittedCodes: [String] = []
    private(set) var confirmedHandles: [String] = []
    private(set) var restoreCount = 0
    private(set) var exportCount = 0

    init(
        listResults: [Result<[MusubiProfile], Error>] = [.success([])],
        statusResults: [Result<MusubiDeletionStatus, Error>] = [.success(.none)],
        switchResults: [Result<MusubiProfile, Error>] = [.success(makeProfile(id: "usr_000000000002"))],
        defaultResults: [Result<MusubiProfile, Error>] = [.success(makeProfile(id: "usr_000000000002"))],
        beginEmailResults: [Result<Bool, Error>] = [.success(true)],
        completeEmailResults: [Result<String, Error>] = [.success("new@example.com")],
        deletionResults: [Result<MusubiDeletionSchedule, Error>] = [
            .success(MusubiDeletionSchedule(scheduledFor: Date(timeIntervalSince1970: 900), alreadyPending: false)),
        ],
        restoreResults: [Result<Bool, Error>] = [.success(true)],
        exportResults: [Result<URL, Error>] = [.success(URL(fileURLWithPath: "/dev/null"))]
    ) {
        self.listResults = listResults
        self.statusResults = statusResults
        self.switchResults = switchResults
        self.defaultResults = defaultResults
        self.beginEmailResults = beginEmailResults
        self.completeEmailResults = completeEmailResults
        self.deletionResults = deletionResults
        self.restoreResults = restoreResults
        self.exportResults = exportResults
    }

    /// Each call consumes the next scripted result; the last one repeats, so
    /// a test needn't script the reload a mutation does.
    private func next<T>(_ results: inout [Result<T, Error>]) throws -> T {
        let result = results.count > 1 ? results.removeFirst() : results[0]
        return try result.get()
    }

    func listProfiles() async throws -> [MusubiProfile] {
        listCount += 1
        return try next(&listResults)
    }

    func deletionStatus() async throws -> MusubiDeletionStatus {
        try next(&statusResults)
    }

    func switchProfile(id: String) async throws -> MusubiProfile {
        switchedIDs.append(id)
        return try next(&switchResults)
    }

    func setDefaultProfile(id: String) async throws -> MusubiProfile {
        defaultedIDs.append(id)
        return try next(&defaultResults)
    }

    func beginEmailChange(to newEmail: String) async throws -> Bool {
        begunEmails.append(newEmail)
        return try next(&beginEmailResults)
    }

    func completeEmailChange(code: String) async throws -> String {
        submittedCodes.append(code)
        return try next(&completeEmailResults)
    }

    func requestDeletion(confirmHandle: String) async throws -> MusubiDeletionSchedule {
        confirmedHandles.append(confirmHandle)
        return try next(&deletionResults)
    }

    func restore() async throws -> Bool {
        restoreCount += 1
        return try next(&restoreResults)
    }

    func exportAccount() async throws -> URL {
        exportCount += 1
        return try next(&exportResults)
    }
}

@MainActor
@Suite struct AccountViewModelTests {
    @Test func loadFetchesBothAndKeepsTheServerOrder() async {
        let api = StubAccountAPI(
            listResults: [.success([makeProfile(id: "usr_a"), makeProfile(id: "usr_b")])],
            statusResults: [.success(.scheduled(
                scheduledFor: Date(timeIntervalSince1970: 900),
                softDeletedAt: Date(timeIntervalSince1970: 100)
            ))]
        )
        let viewModel = AccountViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.profiles.map(\.id) == ["usr_a", "usr_b"])
        #expect(viewModel.deletion?.isScheduled == true)
    }

    /// The profiles are the screen; the banner is a banner. A dead status
    /// call must not blank the rows the user came to read.
    @Test func aFailedStatusStillLoadsTheProfiles() async {
        let api = StubAccountAPI(
            listResults: [.success([makeProfile(id: "usr_a")])],
            statusResults: [.failure(StubError())]
        )
        let viewModel = AccountViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.profiles.map(\.id) == ["usr_a"])
        #expect(viewModel.deletion == nil)
    }

    @Test func aFailedListFailsTheScreen() async {
        let viewModel = AccountViewModel(api: StubAccountAPI(listResults: [.failure(StubError())]))

        await viewModel.load()

        #expect(viewModel.profiles.isEmpty)
        #expect(viewModel.state == .failed("stub failed"))
    }

    /// A switch changes the token, not the list. Re-reading would cost a
    /// round trip to learn nothing.
    @Test func switchingMovesTheMarkerAndTellsTheShell() async {
        let api = StubAccountAPI(
            listResults: [.success([makeProfile(id: "usr_a"), makeProfile(id: "usr_b")])],
            switchResults: [.success(makeProfile(id: "usr_b", handle: "grace"))]
        )
        var adopted: [String] = []
        let viewModel = AccountViewModel(api: api, currentProfileID: "usr_a", onSwitch: { adopted.append($0.id) })
        await viewModel.load()

        await viewModel.switchProfile(id: "usr_b")

        #expect(api.switchedIDs == ["usr_b"])
        #expect(viewModel.currentProfileID == "usr_b")
        #expect(adopted == ["usr_b"])
        #expect(api.listCount == 1)
        #expect(viewModel.switchingID == nil)
    }

    @Test func switchingToTheProfileAlreadyInForceDoesNothing() async {
        let api = StubAccountAPI()
        let viewModel = AccountViewModel(api: api, currentProfileID: "usr_a")

        await viewModel.switchProfile(id: "usr_a")

        #expect(api.switchedIDs.isEmpty)
    }

    /// The token was never re-issued, so the marker must not move — the app
    /// is still the profile it was.
    @Test func aFailedSwitchKeepsTheOldMarker() async {
        let api = StubAccountAPI(switchResults: [.failure(StubError())])
        var adopted: [String] = []
        let viewModel = AccountViewModel(api: api, currentProfileID: "usr_a", onSwitch: { adopted.append($0.id) })

        await viewModel.switchProfile(id: "usr_b")

        #expect(viewModel.currentProfileID == "usr_a")
        #expect(adopted.isEmpty)
        #expect(viewModel.mutationError == "stub failed")
        #expect(viewModel.switchingID == nil)
    }

    /// Setting the default is about the *next* sign-in. Pressing it must not
    /// move the user now.
    @Test func makingADefaultDoesNotSwitch() async {
        let api = StubAccountAPI()
        let viewModel = AccountViewModel(api: api, currentProfileID: "usr_a")

        await viewModel.makeDefault(id: "usr_b")

        #expect(api.defaultedIDs == ["usr_b"])
        #expect(api.switchedIDs.isEmpty)
        #expect(viewModel.currentProfileID == "usr_a")
        #expect(viewModel.makingDefaultID == nil)
    }

    @Test func beginningAnEmailChangeWaitsForTheCode() async {
        let api = StubAccountAPI()
        let viewModel = AccountViewModel(api: api)

        await viewModel.beginEmailChange(to: "new@example.com")

        #expect(api.begunEmails == ["new@example.com"])
        #expect(viewModel.pendingEmail == "new@example.com")
        #expect(!viewModel.isSendingCode)
    }

    /// `sent: false` is a 200 with nothing in the inbox. Putting the user on
    /// the code step would be a lie.
    @Test func anUnsentCodeIsNotProgress() async {
        let api = StubAccountAPI(beginEmailResults: [.success(false)])
        let viewModel = AccountViewModel(api: api)

        await viewModel.beginEmailChange(to: "new@example.com")

        #expect(viewModel.pendingEmail == nil)
        #expect(viewModel.mutationError != nil)
    }

    /// The address is on every profile row, so the rows are stale the moment
    /// it changes.
    @Test func confirmingTheChangeClearsTheStepAndReloads() async {
        let api = StubAccountAPI(
            listResults: [
                .success([makeProfile(id: "usr_a", email: "old@example.com")]),
                .success([makeProfile(id: "usr_a", email: "new@example.com")]),
            ]
        )
        let viewModel = AccountViewModel(api: api)
        await viewModel.load()
        await viewModel.beginEmailChange(to: "new@example.com")

        await viewModel.confirmEmailChange(code: "123456")

        #expect(api.submittedCodes == ["123456"])
        #expect(viewModel.pendingEmail == nil)
        #expect(api.listCount == 2)
        #expect(viewModel.profiles.first?.email == "new@example.com")
    }

    /// A cancelled Face ID sheet arrives as a thrown error. The user keeps
    /// the code step and can try again.
    @Test func aFailedConfirmationKeepsTheCodeStep() async {
        let api = StubAccountAPI(completeEmailResults: [.failure(StubError())])
        let viewModel = AccountViewModel(api: api)
        await viewModel.beginEmailChange(to: "new@example.com")

        await viewModel.confirmEmailChange(code: "123456")

        #expect(viewModel.pendingEmail == "new@example.com")
        #expect(viewModel.mutationError == "stub failed")
        #expect(!viewModel.isConfirmingEmail)
    }

    @Test func cancellingTheEmailChangeChangesNothingElse() async {
        let api = StubAccountAPI()
        let viewModel = AccountViewModel(api: api)
        await viewModel.beginEmailChange(to: "new@example.com")

        viewModel.cancelEmailChange()

        #expect(viewModel.pendingEmail == nil)
        #expect(api.submittedCodes.isEmpty)
    }

    @Test func requestingDeletionRaisesTheBanner() async {
        let api = StubAccountAPI(
            deletionResults: [
                .success(MusubiDeletionSchedule(scheduledFor: Date(timeIntervalSince1970: 900), alreadyPending: false)),
            ]
        )
        let viewModel = AccountViewModel(api: api)

        await viewModel.requestDeletion(confirmHandle: "ada")

        #expect(api.confirmedHandles == ["ada"])
        #expect(viewModel.deletion?.scheduledFor == Date(timeIntervalSince1970: 900))
        #expect(!viewModel.isRequestingDeletion)
    }

    /// A handle the server rejects, or a cancelled ceremony — either way
    /// nothing is scheduled and the banner must stay down.
    @Test func aFailedDeletionRaisesNoBanner() async {
        let api = StubAccountAPI(deletionResults: [.failure(StubError())])
        let viewModel = AccountViewModel(api: api)

        await viewModel.requestDeletion(confirmHandle: "wrong")

        #expect(viewModel.deletion == nil)
        #expect(viewModel.mutationError == "stub failed")
    }

    @Test func restoringLowersTheBanner() async {
        let api = StubAccountAPI(restoreResults: [.success(true)])
        let viewModel = AccountViewModel(api: api)
        await viewModel.requestDeletion(confirmHandle: "ada")

        await viewModel.restore()

        #expect(api.restoreCount == 1)
        #expect(viewModel.deletion == MusubiDeletionStatus.none)
        #expect(!viewModel.isRestoring)
    }

    /// `cancelled: false` means nothing was pending — another device got
    /// there first, or the window closed. This screen's copy is stale, so it
    /// re-reads instead of claiming a rescue that didn't happen.
    @Test func aRestoreThatCancelledNothingReloads() async {
        let api = StubAccountAPI(restoreResults: [.success(false)])
        let viewModel = AccountViewModel(api: api)

        await viewModel.restore()

        #expect(api.listCount == 1)
    }

    @Test func exportingHoldsTheFileForTheSheet() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("account-export-test-\(UUID().uuidString).ndjson")
        try Data("{}\n".utf8).write(to: url)
        let api = StubAccountAPI(exportResults: [.success(url)])
        let viewModel = AccountViewModel(api: api)

        await viewModel.exportAccount()

        #expect(viewModel.exportURL == url)
        #expect(!viewModel.isExporting)

        // Somebody's whole account in plaintext has no business outliving
        // the sheet that shared it.
        viewModel.dismissExport()

        #expect(viewModel.exportURL == nil)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func aFailedExportShowsNoSheet() async {
        let api = StubAccountAPI(exportResults: [.failure(StubError())])
        let viewModel = AccountViewModel(api: api)

        await viewModel.exportAccount()

        #expect(viewModel.exportURL == nil)
        #expect(viewModel.mutationError == "stub failed")
    }
}

@Suite struct MusubiDeletionStatusTests {
    private func decode(_ json: String) throws -> MusubiDeletionStatus {
        let payload = try JSONDecoder().decode(
            Operations.GetAccountDeletionStatus.Output.Ok.Body.JsonPayload.self,
            from: Data(json.utf8)
        )
        return MusubiDeletionStatus(payload)
    }

    @Test func anUnscheduledAccountReadsAsNone() throws {
        #expect(try decode(#"{"scheduled":false}"#) == MusubiDeletionStatus.none)
    }

    /// The trap this type exists for. `anyOf` means *at least* one branch
    /// matched: a scheduled body satisfies the `{ scheduled }` branch too,
    /// so the decoder fills **both** `value1` and `value2`. Reading `value1`
    /// first would quietly report a live account and hide the countdown.
    @Test func aScheduledAccountFillsBothBranchesAndReadsAsScheduled() throws {
        let status = try decode(#"{"scheduled":true,"scheduledFor":900,"softDeletedAt":100}"#)

        #expect(status == .scheduled(
            scheduledFor: Date(timeIntervalSince1970: 900),
            softDeletedAt: Date(timeIntervalSince1970: 100)
        ))
    }
}
