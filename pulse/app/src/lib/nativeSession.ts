import { setSessionFetch, type SessionFetch } from "@osn/client";
import { invoke } from "@tauri-apps/api/core";

import { OSN_ISSUER_URL } from "./auth";
import { isIosWebview } from "./platform";

/**
 * Routes the native transport handles, mirroring `ALLOWED_PATHS` in
 * `src-tauri/plugins/pulse-session/src/commands.rs`. Rust rejects anything
 * outside this set; the copy here exists so that a request Rust would refuse
 * never gets sent at all and falls through to plain `fetch` instead.
 *
 * If you add a route, add it in both places — Rust is the one that enforces.
 */
const NATIVE_PATHS = new Set([
  "/login/passkey/complete",
  "/register/complete",
  "/login/recovery/complete",
  "/token",
  "/logout",
]);

/** Statuses that must not carry a body; `new Response(body, …)` throws if they do. */
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);

interface NativeResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/** Turn the plugin's plain response into a real `Response`. */
function toResponse(native: NativeResponse): Response {
  const headers = new Headers();
  for (const [name, value] of native.headers) {
    // A header the server sent but the platform will not let us set is not
    // worth failing a sign-in over.
    try {
      headers.append(name, value);
    } catch {
      /* ignore */
    }
  }
  const body = BODILESS_STATUSES.has(native.status) ? null : native.body;
  return new Response(body, { status: native.status, headers });
}

/**
 * The iOS transport: hand the request to Rust, which replays the Keychain
 * cookie and captures whatever the server sets.
 *
 * Only the request's *path* crosses the bridge. The origin is fixed in
 * `tauri.conf.json` and resolved in Rust, so a compromised webview cannot
 * point a credentialed request anywhere else.
 */
const nativeSessionFetch: SessionFetch = async (input, init) => {
  let path: string;
  try {
    const url = new URL(input, OSN_ISSUER_URL);
    // A call to some other host is not ours to carry.
    if (url.origin !== new URL(OSN_ISSUER_URL).origin) return fetch(input, init);
    path = url.pathname;
  } catch {
    return fetch(input, init);
  }

  if (!NATIVE_PATHS.has(path)) return fetch(input, init);

  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    // Every call site on these five routes sends a string. Anything else means
    // the caller changed and this adapter did not; failing loudly beats sending
    // the request through `fetch`, where iOS silently drops the session.
    throw new TypeError(`pulse-session: ${path} needs a string body, got ${typeof body}`);
  }

  const native = await invoke<NativeResponse>("plugin:pulse-session|request", {
    request: {
      path,
      method: init.method ?? "POST",
      headers: [...new Headers(init.headers).entries()],
      body: body ?? null,
    },
  });

  return toResponse(native);
};

/**
 * Point `@osn/client` at the native transport when running on iOS.
 *
 * Called once from the app's entry point, before anything can sign in. A no-op
 * everywhere else, so the call site needs no platform check of its own.
 *
 * Why this is needed at all: Pulse's webview serves its document from
 * `tauri://localhost`, and WebKit refuses to store a cookie for a custom-scheme
 * document — measured against every `SameSite` shape, on the wire and in
 * `WKHTTPCookieStore`. osn-api reads the refresh token only from that cookie,
 * so without this the session dies with the first access token.
 */
export function installNativeSession(): void {
  if (!isIosWebview()) return;
  setSessionFetch(nativeSessionFetch);
}
