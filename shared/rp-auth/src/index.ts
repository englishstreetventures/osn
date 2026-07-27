/**
 * Browser half of an OSN **relying party** — the app-side counterpart to
 * `@shared/osn-auth-client`, which is the server half.
 *
 * The shape this package assumes is backend-for-frontend: the app's own API
 * runs the OIDC code exchange and hands the browser its OWN session cookie.
 * The browser never sees an OSN token, never runs a WebAuthn ceremony, and
 * never holds a bearer token to leak. It does three things — ask the API who
 * is signed in, send the user off to sign in, and send the cookie along with
 * API calls.
 *
 * Why this exists rather than `@osn/client`: a WebAuthn ceremony may only run
 * on an origin same-site with the RP ID. Once identity moved to its own zone
 * (`musubi.social`), no other product's origin could mint an OSN credential,
 * so every relying party needs this redirect flow. Sharing it here keeps the
 * cookie handling, the 401 contract, and the error-marker names identical
 * across products instead of copied per app.
 *
 * Nothing in this file imports a UI framework. `@shared/rp-auth/solid` wraps
 * it in a SolidJS provider.
 */

/** What `GET {basePath}/session` reports about the signed-in user. */
export interface RpSession {
  /** The real OSN profile id (`usr_*`) — what the app's own rows are keyed on. */
  osnProfileId: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** ISO 8601. The cookie dies at the same moment. */
  expiresAt: string;
}

export interface RpAuthConfig {
  /** Origin of the app's own API, e.g. `https://api.cireweddings.com`. */
  apiBase: string;
  /** Where the auth routes are mounted on that API. */
  basePath?: string;
  /** Test seam: injectable `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Thrown by `authFetch` when the API answers 401.
 *
 * The `_tag` is load-bearing: callers match on it to decide "bounce to
 * sign-in" versus "show an error". A 401 means the session cookie is gone or
 * elapsed. An authenticated caller who simply lacks permission must get 403
 * from the API — answering 401 there would log them out mid-task.
 */
export class AuthExpiredError extends Error {
  readonly _tag = "AuthExpiredError";

  constructor(message = "Your session has expired. Sign in again.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

/** True when `err` is (or stringifies as) an `AuthExpiredError`. */
export function isAuthExpired(err: unknown): boolean {
  if (err instanceof AuthExpiredError) return true;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return (err as { _tag: unknown })._tag === "AuthExpiredError";
  }
  return false;
}

const DEFAULT_BASE_PATH = "/api/auth";

const authBase = (config: RpAuthConfig): string =>
  `${config.apiBase.replace(/\/+$/, "")}${config.basePath ?? DEFAULT_BASE_PATH}`;

const doFetch = (config: RpAuthConfig): typeof fetch => config.fetch ?? fetch;

export interface SignInOptions {
  /**
   * Ask the issuer to lead with the sign-up screen rather than the sign-in
   * one — "Initiating User Registration via OpenID Connect 1.0". Only
   * `create` is passed through; the API rejects anything else, so an app
   * cannot smuggle `none` (silent authentication) through this seam.
   */
  prompt?: "create";
}

/**
 * Where to send the browser to sign in. `returnTo` is an absolute URL the API
 * re-validates against its own CORS allowlist, so an attacker-supplied value
 * cannot turn this into an open redirect.
 */
export function signInUrl(
  config: RpAuthConfig,
  returnTo: string,
  options: SignInOptions = {},
): string {
  const url = new URL(`${authBase(config)}/oidc/start`);
  url.searchParams.set("return_to", returnTo);
  if (options.prompt) url.searchParams.set("prompt", options.prompt);
  return url.toString();
}

/**
 * Leave for the issuer. A full-page navigation, not `fetch` — the OIDC legs
 * are top-level navigations by design, and `window.open` would land the
 * session cookie in a popup the app cannot see.
 */
export function startSignIn(
  config: RpAuthConfig,
  returnTo?: string,
  options: SignInOptions = {},
): void {
  window.location.assign(signInUrl(config, returnTo ?? window.location.href, options));
}

/**
 * The same journey, opened on the sign-up screen. Someone with no OSN account
 * still ends up signed in to this app at the end of it, so there is one flow
 * here, not two — only the first screen differs.
 */
export function startCreateAccount(config: RpAuthConfig, returnTo?: string): void {
  startSignIn(config, returnTo, { prompt: "create" });
}

/**
 * Who is signed in, or `null`. A signed-out visitor is not an error, so this
 * resolves `null` rather than throwing — including when the API is
 * unreachable, which the UI treats the same way: show the sign-in button.
 */
export async function fetchSession(config: RpAuthConfig): Promise<RpSession | null> {
  let res: Response;
  try {
    res = await doFetch(config)(`${authBase(config)}/session`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;

  const payload = body as Partial<RpSession> & { signedIn?: unknown };
  if (payload.signedIn !== true) return null;
  if (typeof payload.osnProfileId !== "string" || typeof payload.expiresAt !== "string") {
    return null;
  }

  return {
    osnProfileId: payload.osnProfileId,
    email: payload.email ?? null,
    handle: payload.handle ?? null,
    displayName: payload.displayName ?? null,
    avatarUrl: payload.avatarUrl ?? null,
    expiresAt: payload.expiresAt,
  };
}

export interface ResumeSessionOptions {
  /** Where a signed-in visitor belongs. Defaults to the site root. */
  home?: string;
  /**
   * Test seam. Defaults to `sessionStorage` — per-tab, and dies with the tab,
   * which is the right lifetime for a guard about a single navigation. Pass
   * `null` to run without a guard.
   */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /**
   * Test seam. Defaults to `location.replace`, so the sign-in page leaves no
   * history entry: `Back` from the app would otherwise land on a page that
   * bounces forward again.
   */
  navigate?: (url: string) => void;
}

const RESUME_GUARD_KEY = "rp-auth.resumed-at";

/**
 * How long one resume suppresses the next. A ping-pong — sign-in page sends
 * you to the app, the app's first 401 sends you back — completes in well under
 * a second, so a cooldown breaks the loop after a single lap. Someone opening
 * the sign-in page again on purpose takes longer than this, and still gets
 * carried through.
 */
const RESUME_COOLDOWN_MS = 5_000;

/** `sessionStorage`, or `null` where the browser refuses it. */
function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Carry a visitor who is already signed in through to the app, instead of
 * asking them for a session they have got.
 *
 * This is deliberately not the old "redirect to the issuer on mount". It asks
 * *this* app's own API over a first-party cookie, so it is a question the
 * browser will actually answer; and it runs behind the rendered page, so a
 * signed-out visitor — the usual visitor here — waits for nothing and is never
 * navigated away unasked.
 *
 * It cannot see a session at the issuer. That cookie is `SameSite=Lax`, so no
 * background request from a relying party's origin will ever carry it; asking
 * needs a top-level redirect, which is the thing this replaces.
 *
 * Resolves `true` when it navigated.
 */
export async function resumeSession(
  config: RpAuthConfig,
  options: ResumeSessionOptions = {},
): Promise<boolean> {
  const store = options.storage === undefined ? defaultStorage() : options.storage;
  const session = await fetchSession(config);
  if (!session) {
    // Signed out — forget any earlier resume, so the next real one runs.
    store?.removeItem(RESUME_GUARD_KEY);
    return false;
  }

  const last = Number(store?.getItem(RESUME_GUARD_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < RESUME_COOLDOWN_MS) return false;
  store?.setItem(RESUME_GUARD_KEY, String(Date.now()));

  const target = options.home ?? new URL("/", window.location.origin).toString();
  (options.navigate ?? ((url: string) => window.location.replace(url)))(target);
  return true;
}

export interface SignOutOptions {
  /** Drop every session for this profile, not just this browser's. */
  allDevices?: boolean;
}

/**
 * Drop the session. Idempotent and never throws — a sign-out that fails on
 * the network still has to leave the UI signed out, and the caller has no
 * useful recovery.
 */
export async function signOut(config: RpAuthConfig, options: SignOutOptions = {}): Promise<void> {
  const url = `${authBase(config)}/signout${options.allDevices ? "?all=1" : ""}`;
  try {
    await doFetch(config)(url, { method: "POST", credentials: "include" });
  } catch {
    // Cookie may survive on the client, but the next call 401s and the UI
    // bounces to sign-in anyway.
  }
}

export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` that carries the session cookie and turns a 401 into
 * `AuthExpiredError`.
 *
 * `credentials: "include"` is forced rather than defaulted — the API is on a
 * different host from the app in every deployed tier, and the browser omits
 * cookies cross-origin without it.
 */
export function createAuthFetch(config: RpAuthConfig): AuthFetch {
  const run = doFetch(config);
  return async (input, init) => {
    const res = await run(input, { ...init, credentials: "include" });
    if (res.status === 401) throw new AuthExpiredError();
    return res;
  };
}

/**
 * The failure marker the API appends to `return_to` when sign-in did not
 * happen (`sign_in_declined`, `sign_in_failed`). Read once on page load.
 */
export function readAuthError(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get("auth_error");
}

/**
 * Strip `auth_error` from the address bar so a reload does not re-show the
 * message. Replaces rather than pushes: the failed attempt is not a step the
 * back button should return to.
 */
export function clearAuthError(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("auth_error")) return;
  url.searchParams.delete("auth_error");
  window.history.replaceState(null, "", url.toString());
}
