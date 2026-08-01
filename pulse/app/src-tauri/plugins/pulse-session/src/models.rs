use serde::{Deserialize, Serialize};

/// Plugin config, read from the `plugins.pulse-session` key of
/// `tauri.conf.json`. The issuer origin lives here rather than in JS so the
/// webview cannot choose where a credentialed request goes; the per-env
/// overlay (`tauri.prod.conf.json`) swaps it at build time.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub issuer_url: String,
}

/// What the webview asks for. There is no `url` field on purpose — only a
/// path, which `commands::request` matches against the allowlist before
/// joining it to the configured issuer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub path: String,
    pub method: String,
    /// Caller-supplied headers. Filtered to a two-name allowlist; `Cookie`,
    /// `Origin` and `Authorization` are set by Rust or not at all.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

/// What the webview gets back. `Set-Cookie` is absent by construction — see
/// `commands::request`. That absence is what keeps the refresh token out of
/// JS (Copenhagen C3) now that the WebKit cookie jar is unusable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// The request as handed to the platform HTTP client, after validation. The
/// URL is absolute here and was built by Rust, never by the caller.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// One cookie the platform client parsed out of the response. Parsing happens
/// natively (`HTTPCookie.cookies(withResponseHeaderFields:for:)`) because a
/// response may carry several `Set-Cookie` lines and every naive header map
/// collapses them into one comma-joined string.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCookie {
    pub name: String,
    pub value: String,
    /// True when the cookie carried `Max-Age=0` or a past `Expires` — i.e. the
    /// server is clearing it. `/logout` and a failed rotation both do this.
    #[serde(default)]
    pub expired: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeResponse {
    pub status: u16,
    /// Already stripped of `Set-Cookie` on the native side.
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub cookies: Vec<NativeCookie>,
    pub body: String,
}
