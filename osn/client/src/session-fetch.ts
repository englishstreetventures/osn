/**
 * The seam through which cookie-bearing requests leave this package.
 *
 * Every browser has a cookie jar, so on the web this is `fetch` and nothing
 * more. A native iOS app is the exception: it has no browser cookie jar at
 * all, so the session cookie needs somewhere else to live and a transport
 * that knows to send it.
 *
 * So on iOS the app installs a transport that runs the request outside any
 * webview, keeping the cookie in the Keychain instead. That transport is
 * deliberately narrow — it accepts only the routes that actually depend on
 * the cookie — and it lives in the app, not here.
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
