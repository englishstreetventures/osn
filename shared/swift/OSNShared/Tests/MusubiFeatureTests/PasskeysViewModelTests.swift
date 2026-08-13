import Foundation
import Testing
@testable import MusubiFeature

private func makePasskey(id: String, label: String? = "iPhone", lastUsedAt: TimeInterval = 500) -> MusubiPasskey {
    MusubiPasskey(
        id: id,
        label: label,
        createdAt: Date(timeIntervalSince1970: 0),
        lastUsedAt: Date(timeIntervalSince1970: lastUsedAt),
        backupEligible: true,
        backupState: true
    )
}

private struct StubError: Error, CustomStringConvertible {
    let description = "stub failed"
}

/// Scripted `PasskeysAPI`. `@MainActor` rather than an actor because three
/// of the four protocol methods are main-actor-bound — the real ones run
/// `ASAuthorizationController`, which is.
@MainActor
private final class StubPasskeysAPI: PasskeysAPI {
    var listResults: [Result<[MusubiPasskey], Error>]
    var renameResult: Result<Void, Error>
    var deleteResults: [Result<Int, Error>]
    var addResult: Result<Void, Error>
    private(set) var listCount = 0
    private(set) var renamed: [(id: String, label: String)] = []
    private(set) var deletedIDs: [String] = []
    private(set) var addCount = 0

    init(
        listResults: [Result<[MusubiPasskey], Error>] = [.success([])],
        renameResult: Result<Void, Error> = .success(()),
        deleteResults: [Result<Int, Error>] = [.success(1)],
        addResult: Result<Void, Error> = .success(())
    ) {
        self.listResults = listResults
        self.renameResult = renameResult
        self.deleteResults = deleteResults
        self.addResult = addResult
    }

    /// Each call consumes the next scripted result; the last one repeats, so
    /// a test that only cares about the first answer needn't script the
    /// re-list every mutation does.
    func listPasskeys() async throws -> [MusubiPasskey] {
        listCount += 1
        let result = listResults.count > 1 ? listResults.removeFirst() : listResults[0]
        return try result.get()
    }

    func renamePasskey(id: String, label: String) async throws {
        renamed.append((id: id, label: label))
        try renameResult.get()
    }

    func deletePasskey(id: String) async throws -> Int {
        deletedIDs.append(id)
        let result = deleteResults.count > 1 ? deleteResults.removeFirst() : deleteResults[0]
        return try result.get()
    }

    func addPasskey() async throws {
        addCount += 1
        try addResult.get()
    }
}

@MainActor
@Suite struct PasskeysViewModelTests {
    @Test func loadSortsMostRecentlyUsedFirst() async {
        let api = StubPasskeysAPI(
            listResults: [.success([makePasskey(id: "old", lastUsedAt: 100), makePasskey(id: "recent", lastUsedAt: 900)])]
        )
        let viewModel = PasskeysViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.passkeys.map(\.id) == ["recent", "old"])
    }

    @Test func loadFailureIsReported() async {
        let viewModel = PasskeysViewModel(api: StubPasskeysAPI(listResults: [.failure(StubError())]))

        await viewModel.load()

        #expect(viewModel.isEmpty)
        #expect(viewModel.state == .failed("stub failed"))
    }

    /// The rename endpoint answers `{ "success": true }` and not the updated
    /// summary, so the new label can only come from a re-list.
    @Test func renameRefreshesFromTheServer() async {
        let api = StubPasskeysAPI(
            listResults: [
                .success([makePasskey(id: "pk_1", label: "iPhone")]),
                .success([makePasskey(id: "pk_1", label: "Work phone")]),
            ]
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.rename(id: "pk_1", label: "  Work phone  ")

        #expect(api.renamed.map(\.label) == ["Work phone"])
        #expect(api.listCount == 2)
        #expect(viewModel.passkeys.map(\.displayLabel) == ["Work phone"])
        #expect(viewModel.mutatingID == nil)
        #expect(viewModel.mutationError == nil)
    }

    /// A whitespace-only name is not a rename. Caught before the ceremony,
    /// so the user isn't asked for Face ID to do nothing.
    @Test func blankRenameIsNotSent() async {
        let api = StubPasskeysAPI(listResults: [.success([makePasskey(id: "pk_1")])])
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.rename(id: "pk_1", label: "   ")

        #expect(api.renamed.isEmpty)
        #expect(api.listCount == 1)
    }

    /// Cancelling the passkey sheet arrives as a thrown error, and it must
    /// not take the list with it.
    @Test func renameFailureKeepsTheList() async {
        let api = StubPasskeysAPI(
            listResults: [.success([makePasskey(id: "pk_1")])],
            renameResult: .failure(StubError())
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.rename(id: "pk_1", label: "Work phone")

        #expect(viewModel.state == .loaded)
        #expect(viewModel.passkeys.map(\.id) == ["pk_1"])
        #expect(viewModel.mutationError == "stub failed")
        #expect(viewModel.mutatingID == nil)
    }

    /// `remaining` agrees with the local count, so no re-list.
    @Test func deleteDropsTheRowWithoutReloading() async {
        let api = StubPasskeysAPI(
            listResults: [.success([makePasskey(id: "pk_1"), makePasskey(id: "pk_2")])],
            deleteResults: [.success(1)]
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.delete(id: "pk_2")

        #expect(viewModel.passkeys.map(\.id) == ["pk_1"])
        #expect(api.listCount == 1)
    }

    /// The server counts one more than we do — a passkey was enrolled
    /// somewhere else. Its answer wins, and the list catches up.
    @Test func deleteReloadsWhenTheServerCountDisagrees() async {
        let api = StubPasskeysAPI(
            listResults: [
                .success([makePasskey(id: "pk_1"), makePasskey(id: "pk_2")]),
                .success([makePasskey(id: "pk_1"), makePasskey(id: "pk_3")]),
            ],
            deleteResults: [.success(2)]
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.delete(id: "pk_2")

        #expect(api.listCount == 2)
        #expect(viewModel.passkeys.map(\.id) == ["pk_1", "pk_3"])
    }

    @Test func deleteFailureKeepsTheRow() async {
        let api = StubPasskeysAPI(
            listResults: [.success([makePasskey(id: "pk_1"), makePasskey(id: "pk_2")])],
            deleteResults: [.failure(StubError())]
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.delete(id: "pk_2")

        #expect(viewModel.passkeys.map(\.id) == ["pk_1", "pk_2"])
        #expect(viewModel.mutationError == "stub failed")
    }

    /// The account invariant is at least one passkey. The last row offers no
    /// remove button rather than spending a biometric prompt on a call the
    /// server will refuse.
    @Test func theLastPasskeyCannotBeDeleted() async {
        let api = StubPasskeysAPI(listResults: [.success([makePasskey(id: "pk_1")])])
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        #expect(!viewModel.canDelete)
    }

    /// Enrolment returns only an id; the new row's flags are the server's to
    /// describe, so the list comes back from it.
    @Test func addReloadsAndClearsItsFlag() async {
        let api = StubPasskeysAPI(
            listResults: [
                .success([makePasskey(id: "pk_1")]),
                .success([makePasskey(id: "pk_1"), makePasskey(id: "pk_2")]),
            ]
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.add()

        #expect(api.addCount == 1)
        #expect(viewModel.passkeys.map(\.id) == ["pk_1", "pk_2"])
        #expect(!viewModel.isAdding)
    }

    @Test func addFailureIsReportedAndDoesNotReload() async {
        let api = StubPasskeysAPI(
            listResults: [.success([makePasskey(id: "pk_1")])],
            addResult: .failure(StubError())
        )
        let viewModel = PasskeysViewModel(api: api)
        await viewModel.load()

        await viewModel.add()

        #expect(api.listCount == 1)
        #expect(viewModel.mutationError == "stub failed")
        #expect(!viewModel.isAdding)
    }
}
