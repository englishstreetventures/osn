import Foundation
import OSNKit

/// `GET /account/export` — the DSAR bundle (Art. 15 access / Art. 20
/// portability), streamed as NDJSON.
///
/// Hand-written rather than generated, and not because generating it would
/// be awkward: the spec **can't** describe it. The route returns a raw
/// streamed `Response`, so `osn/api` deliberately documents no 200 schema
/// ("a `response` schema is a runtime validator as much as a document —
/// putting one on 200 would make Elysia try to validate a stream it cannot
/// read without consuming it", `osn/api/src/routes/account-export.ts`), and
/// the step-up token rides the `x-step-up-token` header because a GET has
/// no body. The generated client can send neither a header the spec never
/// declares nor decode a body the spec never types.
///
/// Two limits sit in front of it: a pre-auth per-IP throttle, and a
/// per-account cap of one export per 24 hours that is consumed only after a
/// successful step-up — so a cancelled Face ID sheet never burns the day's
/// allowance. Both answer 429.
public final class AccountExportClient: Sendable {
    /// What the server calls the file, taken from its own
    /// `content-disposition`. Kept as a constant rather than parsed back out
    /// of the header: it is a fixed string on the server, and a header parse
    /// would be a second place for it to go wrong.
    public static let filename = "osn-account-export.ndjson"

    private let session: URLSession
    private let environment: Environment

    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    /// - Parameter stepUpToken: minted via `StepUpPasskeyClient` with
    ///   `purpose: .accountExport`. Anything else is a 403 the server reads
    ///   as `step_up_required`.
    /// - Returns: the whole NDJSON bundle. Held in memory rather than
    ///   streamed to disk line by line: this is one person's account, not a
    ///   dataset, and the caller writes it out in one go.
    public func download(stepUpToken: String) async throws -> Data {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("account/export"))
        request.httpMethod = "GET"
        request.setValue(stepUpToken, forHTTPHeaderField: "X-Step-Up-Token")
        try RequestHelpers.applyBearerAccessToken(to: &request)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OSNAuthError.responseMalformed(status: -1)
        }
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        // An empty body would mean the stream died after the headers went
        // out — a 200 that isn't one. Better to say so than to hand the user
        // an empty file and call it their data.
        guard !data.isEmpty else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return data
    }
}
