/**
 * The seam through which cookie-bearing requests leave this package.
 *
 * Every browser has a cookie jar, so on the web this is `fetch` and nothing
 * more. iOS is the exception. Pulse's webview serves its document from
 * `tauri://localhost`, and WebKit treats a custom-scheme document as cross-site
 * to every real host — so it refuses to *store* the session cookie at all, no
 * matter which `SameSite` value the server offers (measured: `document.cookie`
 * empty, no `Cookie` header on the next request, `WKHTTPCookieStore` empty).
 * Injecting the cookie into `WKHTTPCookieStore` from Swift does not help
 * either; the jar itself is unusable for that origin.
 *
 * So on iOS the app installs a transport that runs the request outside WebKit,
 * through a Rust command that keeps the cookie in the Keychain. That transport
 * is deliberately narrow — it accepts only the five routes that actually depend
 * on the cookie — and it lives in the app, not here.
 *
 * What stays here is everything that decides *when* to call: the terminal-vs-
 * transient classification, the retry backoff, the single-flight guards in
 * `service.ts`. Those are tested, and duplicating them behind a native
 * implementation is how the two copies drift apart.
 */

export type SessionFetch = (input: string, init: RequestInit) => Promise<Response>;

const browserFetch: SessionFetch = (input, init) => fetch(input, init);

let current: SessionFetch = browserFetch;

/**
 * Replace the transport. Pass `null` to go back to plain `fetch`.
 *
 * Called once at app boot on iOS, and by tests. Nothing else should call it:
 * a second caller silently takes the session away from the first.
 */
export function setSessionFetch(impl: SessionFetch | null): void {
  current = impl ?? browserFetch;
}

/**
 * Drop-in for `fetch` at the call sites that need the session cookie.
 *
 * Reads `current` per call rather than closing over it, so installing a
 * transport after a module has already imported this still takes effect.
 */
export const sessionFetch: SessionFetch = (input, init) => current(input, init);
