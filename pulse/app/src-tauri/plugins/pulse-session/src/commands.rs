//! The single JS-facing command, and the checks that make it safe to expose.
//!
//! ## Why this exists
//!
//! A Tauri webview on iOS serves the app from `tauri://localhost`. A document
//! at a custom scheme is cross-site to every real host, so WebKit treats every
//! cookie it is offered as third-party and refuses to *store* it — measured on
//! an iOS 26 simulator against all three shapes (`SameSite=Lax`, `None`, and no
//! attribute), on the wire and in `WKHTTPCookieStore`, which came back empty.
//! Injecting the cookie from Swift does not help either: the jar is the thing
//! that is unusable, not just the send path.
//!
//! osn-api reads the refresh token *only* from that cookie
//! (`osn/api/src/routes/auth/tokens.ts`), so on iOS sign-in appears to succeed
//! and then the session dies with the first access token and cannot come back.
//! This transport restores the wire contract without changing the API: Rust
//! keeps the cookie in the Keychain and replays it, and JS keeps every retry
//! and single-flight rule it already has in `osn/client/src/service.ts`.
//!
//! ## Why it is not a general-purpose fetch
//!
//! A JS-callable "send my credentials to this URL" command is ambient
//! authority. Three things fence it in:
//!
//! 1. The caller supplies a *path*, never a URL. The origin comes from
//!    `tauri.conf.json` and is fixed at build time.
//! 2. The path must match [`ALLOWED_PATHS`] exactly — the five routes where
//!    the session cookie is the sole credential or is established. Everywhere
//!    else osn-api already falls back to the access token's `osn_sid` binding
//!    for "a native client", so those routes need nothing from us.
//! 3. `Set-Cookie` never reaches JS. Rust captures it, keeps it, and hands
//!    back a response without it.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_pulse_keychain::PulseKeychainExt;

use crate::{
    models::{NativeCookie, NativeRequest, SessionRequest, SessionResponse},
    Error, PulseSessionExt, Result,
};

/// Routes reachable through this transport. Derived by reading osn-api, not by
/// guessing: these are the ones that call `buildSessionCookie` (establishing or
/// rotating the session) or `readSessionCookie` with no bearer fallback.
///
///   `/login/passkey/complete`   sets the cookie   (routes/auth/login.ts)
///   `/register/complete`        sets the cookie   (routes/auth/registration.ts)
///   `/login/recovery/complete`  sets the cookie   (routes/auth/recovery.ts)
///   `/token`                    reads + rotates   (routes/auth/tokens.ts)
///   `/logout`                   reads + clears    (routes/auth/tokens.ts)
///
/// `/login/cross-device/*` also sets the cookie but Pulse has no client for it;
/// add it here when it grows one.
const ALLOWED_PATHS: &[&str] = &[
    "/login/passkey/complete",
    "/register/complete",
    "/login/recovery/complete",
    "/token",
    "/logout",
];

/// All five allowlisted routes are POSTs. Pinning the method keeps a GET with a
/// replayed cookie off the table entirely.
const ALLOWED_METHOD: &str = "POST";

/// Request headers the caller may set. Everything else is dropped rather than
/// rejected, so an incidental `Accept-Language` does not fail the call — but
/// `Cookie`, `Origin` and `Authorization` can never be caller-controlled.
const ALLOWED_REQUEST_HEADERS: &[&str] = &["content-type", "accept"];

/// Mirrors `SESSION_COOKIE_NAMES` in `osn/api/src/lib/cookie-session.ts`. The
/// `__Host-` form is what a secure deploy sets; the bare name is local-only.
/// Storing by name means a stray CSRF or analytics cookie can never take the
/// session slot.
const SESSION_COOKIE_NAMES: &[&str] = &["__Host-osn_session", "osn_session"];

/// The Origin osn-api's CORS allowlist expects from this app
/// (`IOS_WEBVIEW_ORIGIN` in `osn/api/src/lib/cors-config.ts`). A native request
/// has no browser to attach one, and the Origin guard is what stands in for
/// CSRF protection, so we send it explicitly.
const WEBVIEW_ORIGIN: &str = "tauri://localhost";

/// Keychain account name holding `name=value` for the live session cookie.
/// Device-only and non-syncing; see `plugins/pulse-keychain`.
const KEYCHAIN_KEY: &str = "osn.session.cookie";

/// Normalise the configured issuer to an origin with no trailing slash, or
/// fail. Called once at setup so a misconfigured build dies at boot rather
/// than on the first sign-in.
pub(crate) fn normalise_issuer(raw: &str) -> Result<String> {
    let parsed = url::Url::parse(raw).map_err(|_| Error::BadIssuerUrl)?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(Error::BadIssuerUrl),
    }
    if parsed.host_str().is_none() {
        return Err(Error::BadIssuerUrl);
    }
    // An issuer carrying a path, query or fragment would silently change where
    // the joined URL lands. Refuse instead of quietly trimming it.
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(Error::BadIssuerUrl);
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Build the absolute URL for a request, or reject it.
///
/// The path is compared against the allowlist by exact equality, so there is no
/// traversal, query string or scheme-relative form to sanitise — anything that
/// is not one of five literals is simply not in the set.
pub(crate) fn resolve_target(issuer: &str, path: &str, method: &str) -> Result<String> {
    if !method.eq_ignore_ascii_case(ALLOWED_METHOD) {
        return Err(Error::Rejected);
    }
    if !ALLOWED_PATHS.contains(&path) {
        return Err(Error::Rejected);
    }
    Ok(format!("{issuer}{path}"))
}

/// Keep the handful of headers a caller legitimately sets, drop the rest.
///
/// A value carrying CR or LF is a header-injection attempt, not a typo, so that
/// one fails the whole request rather than being dropped quietly.
pub(crate) fn filter_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>> {
    let mut kept = Vec::new();
    for (name, value) in headers {
        if value.contains('\r') || value.contains('\n') || name.contains('\r') || name.contains('\n')
        {
            return Err(Error::Rejected);
        }
        if ALLOWED_REQUEST_HEADERS
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
        {
            kept.push((name.to_ascii_lowercase(), value.clone()));
        }
    }
    Ok(kept)
}

/// Pick the session cookie out of whatever the response set. Returns `None`
/// when the response set cookies we do not own.
pub(crate) fn pick_session_cookie(cookies: &[NativeCookie]) -> Option<&NativeCookie> {
    cookies
        .iter()
        .find(|c| SESSION_COOKIE_NAMES.contains(&c.name.as_str()))
}

/// Split the stored `name=value` back into a `Cookie` header value. Stored
/// rather than reconstructed because a secure deploy uses `__Host-osn_session`
/// and a local one uses `osn_session`, and the client should not have to know
/// which.
pub(crate) fn cookie_header_from_stored(stored: &str) -> Option<String> {
    let (name, _) = stored.split_once('=')?;
    if !SESSION_COOKIE_NAMES.contains(&name) {
        return None;
    }
    Some(stored.to_string())
}

/// Perform a credentialed request against the configured issuer.
///
/// The only IPC surface this plugin has. See the module docs for why it is
/// shaped the way it is.
#[tauri::command]
pub(crate) async fn request<R: Runtime>(
    app: AppHandle<R>,
    request: SessionRequest,
) -> Result<SessionResponse> {
    let issuer = app.state::<IssuerOrigin>();
    let url = resolve_target(&issuer.0, &request.path, &request.method)?;
    let mut headers = filter_headers(&request.headers)?;
    headers.push(("origin".to_string(), WEBVIEW_ORIGIN.to_string()));

    // Replay the stored cookie, if we have one. A missing cookie is normal —
    // sign-in is exactly the case where none exists yet.
    let keychain = app.pulse_keychain();
    if let Some(stored) = keychain
        .get(KEYCHAIN_KEY.to_string())
        .map_err(|e| Error::Keychain(e.to_string()))?
    {
        if let Some(value) = cookie_header_from_stored(&stored) {
            headers.push(("cookie".to_string(), value));
        }
    }

    let native = NativeRequest {
        url,
        method: ALLOWED_METHOD.to_string(),
        headers,
        body: request.body,
    };

    let response = app.pulse_session().request(native)?;

    // Persist whatever the server just set, before returning. Rotation
    // (`/token`) and clearing (`/logout`) both arrive this way.
    if let Some(cookie) = pick_session_cookie(&response.cookies) {
        if cookie.expired {
            keychain
                .delete(KEYCHAIN_KEY.to_string())
                .map_err(|e| Error::Keychain(e.to_string()))?;
        } else {
            keychain
                .set(
                    KEYCHAIN_KEY.to_string(),
                    format!("{}={}", cookie.name, cookie.value),
                )
                .map_err(|e| Error::Keychain(e.to_string()))?;
        }
    }

    // `response.headers` already excludes `Set-Cookie` — the native side strips
    // it — and `response.cookies` is dropped here. Nothing carrying the refresh
    // token crosses back into JS.
    Ok(SessionResponse {
        status: response.status,
        headers: response.headers,
        body: response.body,
    })
}

/// The validated issuer origin, resolved once at plugin setup.
pub(crate) struct IssuerOrigin(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuer_must_be_a_bare_http_origin() {
        assert_eq!(
            normalise_issuer("https://id.musubi.social").unwrap(),
            "https://id.musubi.social"
        );
        assert_eq!(
            normalise_issuer("http://localhost:4000/").unwrap(),
            "http://localhost:4000"
        );
        // A path would silently move every joined URL.
        assert!(normalise_issuer("https://id.musubi.social/oauth").is_err());
        assert!(normalise_issuer("https://id.musubi.social/?a=b").is_err());
        assert!(normalise_issuer("file:///etc/passwd").is_err());
        assert!(normalise_issuer("not a url").is_err());
    }

    #[test]
    fn only_allowlisted_paths_resolve() {
        let issuer = "https://id.musubi.social";
        assert_eq!(
            resolve_target(issuer, "/token", "POST").unwrap(),
            "https://id.musubi.social/token"
        );
        assert!(resolve_target(issuer, "/sessions", "POST").is_err());
        assert!(resolve_target(issuer, "/token?x=1", "POST").is_err());
        assert!(resolve_target(issuer, "/../token", "POST").is_err());
        assert!(resolve_target(issuer, "//evil.example/token", "POST").is_err());
        // An absolute URL is not a path, so it is not in the set either.
        assert!(resolve_target(issuer, "https://evil.example/token", "POST").is_err());
    }

    #[test]
    fn only_post_is_accepted() {
        let issuer = "https://id.musubi.social";
        assert!(resolve_target(issuer, "/token", "post").is_ok());
        assert!(resolve_target(issuer, "/token", "GET").is_err());
        assert!(resolve_target(issuer, "/token", "OPTIONS").is_err());
    }

    #[test]
    fn caller_headers_are_filtered_not_trusted() {
        let supplied = vec![
            ("Content-Type".into(), "application/json".into()),
            ("Cookie".into(), "osn_session=stolen".into()),
            ("Origin".into(), "https://evil.example".into()),
            ("Authorization".into(), "Bearer x".into()),
        ];
        let kept = filter_headers(&supplied).unwrap();
        assert_eq!(kept, vec![("content-type".to_string(), "application/json".to_string())]);
    }

    #[test]
    fn header_injection_fails_the_request() {
        let supplied = vec![(
            "Content-Type".into(),
            "application/json\r\nCookie: osn_session=stolen".into(),
        )];
        assert!(filter_headers(&supplied).is_err());
    }

    #[test]
    fn only_the_session_cookie_is_stored() {
        let cookies = vec![
            NativeCookie { name: "cf_bm".into(), value: "x".into(), expired: false },
            NativeCookie { name: "osn_session".into(), value: "abc".into(), expired: false },
        ];
        let picked = pick_session_cookie(&cookies).unwrap();
        assert_eq!(picked.name, "osn_session");

        let unrelated = vec![NativeCookie {
            name: "cf_bm".into(),
            value: "x".into(),
            expired: false,
        }];
        assert!(pick_session_cookie(&unrelated).is_none());
    }

    #[test]
    fn host_prefixed_name_round_trips() {
        assert_eq!(
            cookie_header_from_stored("__Host-osn_session=abc").unwrap(),
            "__Host-osn_session=abc"
        );
        // Anything that is not ours is not replayed, even if it got in somehow.
        assert!(cookie_header_from_stored("evil=abc").is_none());
        assert!(cookie_header_from_stored("nonsense").is_none());
    }
}
