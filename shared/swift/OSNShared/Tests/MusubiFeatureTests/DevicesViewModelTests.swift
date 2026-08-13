import Foundation
import Testing
@testable import MusubiFeature

private let nowSeconds: Double = 1_700_000_000

private func makeDevice(
    id: String,
    lastUsedAt: Double = nowSeconds,
    isCurrent: Bool = false
) -> MusubiDevice {
    MusubiDevice(
        id: id,
        label: "iPhone · Safari",
        createdAt: Date(timeIntervalSince1970: nowSeconds),
        lastUsedAt: Date(timeIntervalSince1970: lastUsedAt),
        expiresAt: Date(timeIntervalSince1970: nowSeconds + 2_592_000),
        isCurrent: isCurrent
    )
}

private struct StubError: Error, CustomStringConvertible {
    let description = "stub failed"
}

/// Scripted `DevicesAPI`. An actor because the view model calls it from
/// `@MainActor` code and the stub records calls across those hops.
private actor StubDevicesAPI: DevicesAPI {
    var listResults: [Result<[MusubiDevice], Error>]
    var revokeResults: [Result<Bool, Error>]
    var revokeOthersResult: Result<Void, Error>
    private(set) var revokedIDs: [String] = []
    private(set) var listCount = 0
    private(set) var revokeOthersCount = 0

    init(
        listResults: [Result<[MusubiDevice], Error>] = [.success([])],
        revokeResults: [Result<Bool, Error>] = [.success(false)],
        revokeOthersResult: Result<Void, Error> = .success(())
    ) {
        self.listResults = listResults
        self.revokeResults = revokeResults
        self.revokeOthersResult = revokeOthersResult
    }

    /// Each call consumes the next scripted result; the last one repeats, so
    /// a test that only cares about the first answer doesn't have to script
    /// the refresh that follows a revoke-all.
    func listDevices() async throws -> [MusubiDevice] {
        listCount += 1
        let result = listResults.count > 1 ? listResults.removeFirst() : listResults[0]
        return try result.get()
    }

    func revokeDevice(id: String) async throws -> Bool {
        revokedIDs.append(id)
        let result = revokeResults.count > 1 ? revokeResults.removeFirst() : revokeResults[0]
        return try result.get()
    }

    func revokeOtherDevices() async throws {
        revokeOthersCount += 1
        try revokeOthersResult.get()
    }
}

@MainActor
@Suite struct DevicesViewModelTests {
    private func makeViewModel(
        api: StubDevicesAPI,
        onSessionEnded: @escaping @MainActor () async -> Void = {}
    ) -> DevicesViewModel {
        DevicesViewModel(api: api, onSessionEnded: onSessionEnded)
    }

    @Test func loadSortsTheCurrentDeviceFirst() async {
        let api = StubDevicesAPI(
            listResults: [.success([makeDevice(id: "other", lastUsedAt: nowSeconds + 500), makeDevice(id: "mine", isCurrent: true)])]
        )
        let viewModel = makeViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.devices.map(\.id) == ["mine", "other"])
    }

    @Test func loadFailureIsReported() async {
        let viewModel = makeViewModel(api: StubDevicesAPI(listResults: [.failure(StubError())]))

        await viewModel.load()

        #expect(viewModel.isEmpty)
        #expect(viewModel.state == .failed("stub failed"))
    }

    @Test func revokingAnotherDeviceDropsItsRowWithoutReloading() async {
        let api = StubDevicesAPI(
            listResults: [.success([makeDevice(id: "mine", isCurrent: true), makeDevice(id: "other")])],
            revokeResults: [.success(false)]
        )
        let viewModel = makeViewModel(api: api)
        await viewModel.load()

        await viewModel.revoke(id: "other")

        #expect(viewModel.devices.map(\.id) == ["mine"])
        #expect(await api.listCount == 1)
        #expect(viewModel.revokingID == nil)
        #expect(viewModel.revokeError == nil)
    }

    /// Revoking the session the app is running on ends it. The trigger is
    /// the server's `revokedSelf`, not the row's `isCurrent` flag — which
    /// is why the stub reports `true` for a row marked otherwise.
    @Test func revokedSelfEndsTheAppSession() async {
        let api = StubDevicesAPI(
            listResults: [.success([makeDevice(id: "other")])],
            revokeResults: [.success(true)]
        )
        var endedCount = 0
        let viewModel = makeViewModel(api: api, onSessionEnded: { endedCount += 1 })
        await viewModel.load()

        await viewModel.revoke(id: "other")

        #expect(endedCount == 1)
        // The row is left alone: the session is over, and the list goes
        // away with the signed-in screen.
        #expect(viewModel.devices.map(\.id) == ["other"])
    }

    /// A failed revoke keeps the list — the other rows are still actionable.
    @Test func revokeFailureKeepsTheList() async {
        let api = StubDevicesAPI(
            listResults: [.success([makeDevice(id: "mine", isCurrent: true), makeDevice(id: "other")])],
            revokeResults: [.failure(StubError())]
        )
        let viewModel = makeViewModel(api: api)
        await viewModel.load()

        await viewModel.revoke(id: "other")

        #expect(viewModel.devices.map(\.id) == ["mine", "other"])
        #expect(viewModel.state == .loaded)
        #expect(viewModel.revokeError == "stub failed")
        #expect(viewModel.revokingID == nil)
    }

    /// Re-listing after revoke-all is the point: the server decides what
    /// "other" meant, including any session created since the last list.
    @Test func revokeAllOthersRefreshesFromTheServer() async {
        let api = StubDevicesAPI(
            listResults: [
                .success([makeDevice(id: "mine", isCurrent: true), makeDevice(id: "other")]),
                .success([makeDevice(id: "mine", isCurrent: true)]),
            ]
        )
        let viewModel = makeViewModel(api: api)
        await viewModel.load()

        await viewModel.revokeAllOthers()

        #expect(await api.revokeOthersCount == 1)
        #expect(await api.listCount == 2)
        #expect(viewModel.devices.map(\.id) == ["mine"])
    }

    @Test func revokeAllOthersFailureDoesNotReload() async {
        let api = StubDevicesAPI(
            listResults: [.success([makeDevice(id: "mine", isCurrent: true), makeDevice(id: "other")])],
            revokeOthersResult: .failure(StubError())
        )
        let viewModel = makeViewModel(api: api)
        await viewModel.load()

        await viewModel.revokeAllOthers()

        #expect(await api.listCount == 1)
        #expect(viewModel.devices.map(\.id) == ["mine", "other"])
        #expect(viewModel.revokeError == "stub failed")
    }
}
