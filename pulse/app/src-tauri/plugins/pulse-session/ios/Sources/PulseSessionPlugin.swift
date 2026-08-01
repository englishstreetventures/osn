import Foundation
import Tauri

// Transport only. Every decision about *what* may be requested — the origin,
// the path allowlist, which cookie is kept — is made in Rust before this runs
// (see src/commands.rs). This file's whole job is to perform the request the
// way a browser would not: outside WebKit, so the cookie jar that refuses
// custom-scheme documents is not involved.

class RequestArgs: Decodable {
  let url: String
  let method: String
  // Ordered pairs rather than a dictionary: `Set-Cookie` aside, header order
  // is not meaningful, but keeping the wire shape symmetrical with Rust's
  // `Vec<(String, String)>` avoids a translation layer that could drop one.
  let headers: [[String]]
  let body: String?
}

/// A session with no cookie storage at all.
///
/// The point of this plugin is that Rust owns the jar; letting `URLSession`
/// keep a second, invisible copy would mean two sources of truth for the
/// rotating refresh token, and the one that survives an app restart would be
/// the wrong one. `.ephemeral` plus the explicit flags below makes that
/// impossible rather than unlikely.
private let transportSession: URLSession = {
  let config = URLSessionConfiguration.ephemeral
  config.httpCookieAcceptPolicy = .never
  config.httpCookieStorage = nil
  config.httpShouldSetCookies = false
  config.requestCachePolicy = .reloadIgnoringLocalCacheData
  config.urlCache = nil
  return URLSession(configuration: config)
}()

class PulseSessionPlugin: Plugin {
  @objc public func request(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RequestArgs.self)

    guard let url = URL(string: args.url) else {
      invoke.reject("pulse-session: Rust produced a URL Foundation cannot parse")
      return
    }

    var req = URLRequest(url: url)
    req.httpMethod = args.method
    // Belt and braces: the session already has no jar, but this also stops
    // Foundation attaching anything from a shared storage if the config above
    // is ever loosened.
    req.httpShouldHandleCookies = false
    for pair in args.headers where pair.count == 2 {
      req.setValue(pair[1], forHTTPHeaderField: pair[0])
    }
    if let body = args.body {
      req.httpBody = body.data(using: .utf8)
    }

    transportSession.dataTask(with: req) { data, response, error in
      if let error = error {
        invoke.reject("pulse-session: \(error.localizedDescription)")
        return
      }
      guard let http = response as? HTTPURLResponse else {
        invoke.reject("pulse-session: response was not HTTP")
        return
      }

      // `allHeaderFields` joins repeated `Set-Cookie` lines with commas, and
      // splitting that string by hand is the classic way to corrupt a cookie
      // whose Expires date also contains a comma. `HTTPCookie` is written for
      // exactly this input, so let it do the parsing.
      let rawHeaders = http.allHeaderFields as? [String: String] ?? [:]
      let parsed = HTTPCookie.cookies(withResponseHeaderFields: rawHeaders, for: url)

      let now = Date()
      let cookies: [[String: Any]] = parsed.map { cookie in
        // `Max-Age=0` and a past `Expires` both mean "clear this" — that is how
        // `/logout` and a rejected rotation arrive.
        let expired = cookie.expiresDate.map { $0 <= now } ?? false
        return ["name": cookie.name, "value": cookie.value, "expired": expired]
      }

      // Strip `Set-Cookie` here so the refresh token cannot reach JS even if a
      // later change forgets to filter on the Rust side.
      let headers: [[String]] = rawHeaders
        .filter { $0.key.lowercased() != "set-cookie" }
        .map { [$0.key, $0.value] }

      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""

      invoke.resolve([
        "status": http.statusCode,
        "headers": headers,
        "cookies": cookies,
        "body": body,
      ])
    }.resume()
  }
}

@_cdecl("init_plugin_pulse_session")
func initPlugin() -> Plugin {
  return PulseSessionPlugin()
}
