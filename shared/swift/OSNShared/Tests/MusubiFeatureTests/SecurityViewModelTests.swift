import Foundation
import Testing
@testable import MusubiFeature

private func makeEvent(
    id: String,
    kind: SecurityEventKind = .passkeyRegister,
    createdAt: TimeInterval = 500
) -> MusubiSecurityEvent {
    MusubiSecurityEvent(
        id: id,
        kind: kind,
        createdAt: Date(timeIntervalSince1970: createdAt),
        deviceLabel: "iPhone",
        ipHash: "0123456789abcdef"
    )
}

private struct StubError: Error, CustomStringConvertible {
    let description = "stub failed"
}

/// Scripted `SecurityAPI`. `@MainActor` for the same reason the passkeys
/// stub is: three of the five methods run a passkey ceremony in the real
/// conformance, and `ASAuthorizationController` is main-actor-bound.
@MainActor
private final class StubSecurityAPI: SecurityAPI {
    var listResults: [Result<[MusubiSecurityEvent], Error>]
    var statusResults: [Result<MusubiRecoveryStatus, Error>]
    var ackResults: [Result<Bool, Error>]
    var ackAllResults: [Result<Int, Error>]
    var generateResult: Result<[String], Error>
    private(set) var listCount = 0
    private(set) var statusCount = 0
    private(set) var ackedIDs: [String] = []
    private(set) var ackAllCount = 0
    private(set) var generateCount = 0

    init(
        listResults: [Result<[MusubiSecurityEvent], Error>] = [.success([])],
        statusResults: [Result<MusubiRecoveryStatus, Error>] = [
            .success(MusubiRecoveryStatus(active: 10, total: 10, generatedAt: nil)),
        ],
        ackResults: [Result<Bool, Error>] = [.success(true)],
        ackAllResults: [Result<Int, Error>] = [.success(0)],
        generateResult: Result<[String], Error> = .success([])
    ) {
        self.listResults = listResults
        self.statusResults = statusResults
        self.ackResults = ackResults
        self.ackAllResults = ackAllResults
        self.generateResult = generateResult
    }

    /// Each call consumes the next scripted result; the last one repeats, so
    /// a test needn't script the reload every mutation does.
    private func next<T>(_ results: inout [Result<T, Error>]) throws -> T {
        let result = results.count > 1 ? results.removeFirst() : results[0]
        return try result.get()
    }

    func listSecurityEvents() async throws -> [MusubiSecurityEvent] {
        listCount += 1
        return try next(&listResults)
    }

    func recoveryStatus() async throws -> MusubiRecoveryStatus {
        statusCount += 1
        return try next(&statusResults)
    }

    func acknowledgeEvent(id: String) async throws -> Bool {
        ackedIDs.append(id)
        return try next(&ackResults)
    }

    func acknowledgeAllEvents() async throws -> Int {
        ackAllCount += 1
        return try next(&ackAllResults)
    }

    func generateRecoveryCodes() async throws -> [String] {
        generateCount += 1
        return try generateResult.get()
    }
}

@MainActor
@Suite struct SecurityViewModelTests {
    @Test func loadFetchesBothAndSortsNewestFirst() async {
        let api = StubSecurityAPI(
            listResults: [.success([makeEvent(id: "old", createdAt: 100), makeEvent(id: "new", createdAt: 900)])],
            statusResults: [.success(MusubiRecoveryStatus(active: 7, total: 10, generatedAt: nil))]
        )
        let viewModel = SecurityViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.events.map(\.id) == ["new", "old"])
        #expect(viewModel.recovery?.active == 7)
    }

    /// The feed is the screen; the counts are a header. A dead status call
    /// must not blank the rows the user came to read.
    @Test func aFailedStatusStillLoadsTheFeed() async {
        let api = StubSecurityAPI(
            listResults: [.success([makeEvent(id: "sev_1")])],
            statusResults: [.failure(StubError())]
        )
        let viewModel = SecurityViewModel(api: api)

        await viewModel.load()

        #expect(viewModel.state == .loaded)
        #expect(viewModel.events.map(\.id) == ["sev_1"])
        #expect(viewModel.recovery == nil)
    }

    @Test func aFailedListFailsTheScreen() async {
        let viewModel = SecurityViewModel(api: StubSecurityAPI(listResults: [.failure(StubError())]))

        await viewModel.load()

        #expect(viewModel.isEmpty)
        #expect(viewModel.state == .failed("stub failed"))
    }

    @Test func acknowledgingDropsTheRowWithoutReloading() async {
        let api = StubSecurityAPI(
            listResults: [.success([makeEvent(id: "sev_1"), makeEvent(id: "sev_2")])],
            ackResults: [.success(true)]
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.acknowledge(id: "sev_2")

        #expect(api.ackedIDs == ["sev_2"])
        #expect(viewModel.events.map(\.id) == ["sev_1"])
        #expect(api.listCount == 1)
        #expect(viewModel.acknowledgingID == nil)
    }

    /// `false` means the server had nothing unacknowledged under that id —
    /// another device cleared it. The list is stale, so it re-reads rather
    /// than guessing which rows also went.
    @Test func aFalseAcknowledgementReloads() async {
        let api = StubSecurityAPI(
            listResults: [
                .success([makeEvent(id: "sev_1"), makeEvent(id: "sev_2")]),
                .success([makeEvent(id: "sev_3")]),
            ],
            ackResults: [.success(false)]
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.acknowledge(id: "sev_2")

        #expect(api.listCount == 2)
        #expect(viewModel.events.map(\.id) == ["sev_3"])
    }

    /// Cancelling Face ID arrives as a thrown error. It reports, and the
    /// feed stays exactly as it was.
    @Test func aFailedAcknowledgementKeepsTheRow() async {
        let api = StubSecurityAPI(
            listResults: [.success([makeEvent(id: "sev_1")])],
            ackResults: [.failure(StubError())]
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.acknowledge(id: "sev_1")

        #expect(viewModel.state == .loaded)
        #expect(viewModel.events.map(\.id) == ["sev_1"])
        #expect(viewModel.mutationError == "stub failed")
        #expect(viewModel.acknowledgingID == nil)
    }

    @Test func acknowledgeAllClearsTheFeedWhenTheCountsAgree() async {
        let api = StubSecurityAPI(
            listResults: [.success([makeEvent(id: "sev_1"), makeEvent(id: "sev_2")])],
            ackAllResults: [.success(2)]
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.acknowledgeAll()

        #expect(api.ackAllCount == 1)
        #expect(viewModel.isEmpty)
        #expect(api.listCount == 1)
        #expect(!viewModel.isAcknowledgingAll)
    }

    /// The server cleared three while this screen knew of two — an event
    /// landed during the ceremony. Its count wins and the feed re-reads.
    @Test func acknowledgeAllReloadsWhenTheCountsDisagree() async {
        let api = StubSecurityAPI(
            listResults: [
                .success([makeEvent(id: "sev_1"), makeEvent(id: "sev_2")]),
                .success([makeEvent(id: "sev_4")]),
            ],
            ackAllResults: [.success(3)]
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.acknowledgeAll()

        #expect(api.listCount == 2)
        #expect(viewModel.events.map(\.id) == ["sev_4"])
    }

    /// Generating writes a `recovery_code_generate` event of its own, so the
    /// feed the user is looking at is short a row until it re-reads — and
    /// the counts have changed too.
    @Test func generatingHoldsTheCodesAndReloadsBoth() async {
        let api = StubSecurityAPI(
            listResults: [
                .success([]),
                .success([makeEvent(id: "sev_gen", kind: .recoveryCodeGenerate)]),
            ],
            statusResults: [
                .success(MusubiRecoveryStatus(active: 0, total: 0, generatedAt: nil)),
                .success(MusubiRecoveryStatus(active: 10, total: 10, generatedAt: Date(timeIntervalSince1970: 900))),
            ],
            generateResult: .success(["code-1", "code-2"])
        )
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.generateRecoveryCodes()

        #expect(api.generateCount == 1)
        #expect(viewModel.freshCodes == ["code-1", "code-2"])
        #expect(viewModel.events.map(\.id) == ["sev_gen"])
        #expect(viewModel.recovery?.active == 10)
        #expect(!viewModel.isGenerating)
    }

    /// Dismissing the sheet is the only exit, and after it nothing can show
    /// the plaintext again. That is the contract, not a lost value.
    @Test func dismissingForgetsTheCodes() async {
        let api = StubSecurityAPI(generateResult: .success(["code-1"]))
        let viewModel = SecurityViewModel(api: api)

        await viewModel.generateRecoveryCodes()
        #expect(viewModel.freshCodes != nil)

        viewModel.dismissCodes()

        #expect(viewModel.freshCodes == nil)
    }

    @Test func aFailedGenerateReportsAndShowsNoSheet() async {
        let api = StubSecurityAPI(generateResult: .failure(StubError()))
        let viewModel = SecurityViewModel(api: api)
        await viewModel.load()

        await viewModel.generateRecoveryCodes()

        #expect(viewModel.freshCodes == nil)
        #expect(viewModel.mutationError == "stub failed")
        #expect(api.listCount == 1)
        #expect(!viewModel.isGenerating)
    }
}
