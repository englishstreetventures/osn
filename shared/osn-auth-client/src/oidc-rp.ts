import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { generateToken, sha256Base64Url } from "@shared/crypto/tokens";

import { verifyIdToken } from "./verify-id-token";

/**
 * OIDC **relying-party** half of signing in with an OSN account — the server
 * side of the flow whose browser side is `@shared/rp-auth`.
 *
 * Every product here used to run the passkey ceremony itself against
 * `@osn/client`. None of them can any more: identity moved to its own zone
 * (`musubi.social`) and a WebAuthn ceremony may only run on an origin same-site
 * with the RP ID, so no other product's origin can mint an OSN credential.
 * Instead each product is a plain OIDC relying party — redirect to the issuer's
 * `/authorize`, take an authorization code back, exchange it back-channel, and
 * mint its OWN session from the ID token.
 *
 * It is shared rather than copied because the subtle parts — session-fixation
 * defence on the transaction cookie, the open-redirect guard, PKCE, and the
 * `osn_profile_id` requirement — must be fixed in one place, not in each
 * product that happened to copy them.
 *
 * Three things about this flow are load-bearing:
 *
 * 1. **One registered redirect URI.** A product may serve several organiser- or
 *    guest-facing origins, but only `.../api/auth/oidc/callback` on its API host
 *    is registered with the issuer. The final destination rides in our own
 *    transaction state and is re-validated against the CORS allowlist on the way
 *    out, so the redirect URI stays a constant and there is no open redirect to
 *    hand the issuer.
 *
 * 2. **`osn_profile_id`, not `sub`.** The ID token's `sub` is the PAIRWISE
 *    subject — deliberately per-client and meaningless to the OSN graph. Every
 *    row a relying party owns is keyed on the real `usr_*` profile id, which
 *    arrives only in the first-party `osn_profile_id` claim. A token without it
 *    is refused outright — falling back to `sub` would silently orphan every
 *    existing row.
 *
 * 3. **client_secret_post, never Basic.** The issuer's token endpoint refuses a
 *    request that carries both (RFC 6749 §2.3), so sending one and only one is
 *    not a style choice.
 */

/** Scopes we ask for. `email` is separate consent; the product's UI shows it. */
const SCOPE = "openid profile email";

/**
 * Ten minutes to get through the issuer's login + consent screens. Long enough
 * for a passkey prompt and a first-time consent read; short enough that a stale
 * transaction cookie left in a browser is worthless.
 */
const TX_TTL_SECONDS = 10 * 60;

/**
 * Who the ID token says signed in. A relying party hangs its own session on
 * this — `osnProfileId` is the only field its rows may be keyed on.
 */
export interface OsnIdentity {
  /** The real `usr_*` profile id, from the first-party `osn_profile_id` claim. */
  osnProfileId: string;
  /** The pairwise `sub`. Kept for audit; never a foreign key. */
  osnSub: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * The one call shape the back-channel token exchange makes. Deliberately
 * narrower than `typeof fetch`, which under bun-types also carries
 * `fetch.preconnect` — a test stub is a plain function and could never satisfy
 * that. The real global `fetch` still slots in.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OidcConfig {
  /** Issuer origin, e.g. `https://id.musubi.social`. No trailing slash. */
  issuer: string;
  /** JWKS endpoint of that issuer (ID-token signature verification). */
  jwksUrl: string;
  clientId: string;
  clientSecret: string;
  /** The ONE registered redirect URI. Must match byte-for-byte at both legs. */
  redirectUri: string;
  /** Origins a `return_to` may point at — the same allowlist CORS echoes. */
  allowedReturnOrigins: readonly string[];
  /**
   * HKDF `info` string for the transaction-cookie MAC key — **distinct per
   * product** (`cire-oidc-tx-hmac-v1`, `pulse-oidc-tx-hmac-v1`, …). Required
   * rather than defaulted: two products that shared a client secret would
   * otherwise silently share a MAC key, and one's transaction cookie would
   * verify at the other. Changing it invalidates only in-flight transactions,
   * which live ten minutes.
   */
  txHmacInfo: string;
  /** Test seam: skip the JWKS fetch and verify with this key. */
  _testKey?: CryptoKey;
  /** Test seam: injectable `fetch` for the back-channel token exchange. */
  _fetch?: FetchLike;
}

/** What `/start` hands the route: where to send the browser, and what to remember. */
export interface OidcStart {
  authorizeUrl: string;
  /** Opaque cookie value — `<b64url payload>.<b64url HMAC>`, Set-Cookie safe. */
  tx: string;
  txMaxAgeSeconds: number;
}

export type OidcFailureReason =
  | "bad_request"
  | "state_mismatch"
  | "exchange_failed"
  | "token_invalid";

export type OidcComplete =
  | { ok: true; identity: OsnIdentity; returnTo: string }
  | { ok: false; reason: OidcFailureReason; returnTo: string | null };

interface TxState {
  /** Schema version — a shape change must not be readable as the old shape. */
  v: 1;
  /** CSRF binding: echoed by the issuer as `state`, matched against the cookie. */
  s: string;
  /** Replay binding: must come back inside the ID token. */
  n: string;
  /** PKCE code verifier. */
  cv: string;
  /** Where to send the browser once the session cookie is set. */
  r: string;
  /** Absolute expiry, ms since epoch. */
  x: number;
}

// ---------------------------------------------------------------------------
// Transaction cookie integrity (HMAC-SHA256).
//
// The transaction cookie carries the whole login transaction — `state`,
// `nonce`, PKCE verifier and return destination. It is host-scoped to the app's
// API, but a sibling origin (or any code able to write a cookie the browser
// will send here) could otherwise PLANT a transaction of its own: a base64url
// JSON blob with no integrity protection is forgeable by anyone. A planted
// transaction fixates the victim's sign-in on the ATTACKER's `state` / `nonce`
// / verifier, so the code the victim's issuer mints exchanges into the
// attacker's identity and the victim ends up signed into the attacker's account
// (a classic OAuth session-fixation / login-CSRF).
//
// So the payload is authenticated: `<b64url(json)>.<b64url(hmac)>`, where the
// MAC is HMAC-SHA256 over the base64url PAYLOAD string under a key derived from
// a server-side secret. `decodeTx` recomputes the MAC and rejects on mismatch
// with a constant-time compare — a forged or tampered cookie decodes to `null`
// and the flow fails closed with `state_mismatch`.
//
// KEY: derived (HKDF-SHA256, per-product `info` string) from the OIDC client
// secret rather than reusing it raw — the client secret is already threaded
// into every place that touches this cookie (`OidcConfig`), present exactly
// when the OIDC routes are, and never leaves the server. No new secret to
// provision.

const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlToBytes = (raw: string): Uint8Array =>
  Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** HKDF-SHA256 derive a dedicated HMAC key from the OIDC client secret. */
async function deriveTxHmacKey(secret: string, info: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** MAC over the base64url payload, as a base64url string. */
async function txMac(payload: string, secret: string, info: string): Promise<string> {
  const key = await deriveTxHmacKey(secret, info);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToB64url(new Uint8Array(sig));
}

export const encodeTx = async (state: TxState, secret: string, info: string): Promise<string> => {
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify(state)));
  const mac = await txMac(payload, secret, info);
  return `${payload}.${mac}`;
};

export const decodeTx = async (
  raw: string,
  secret: string,
  info: string,
): Promise<TxState | null> => {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const payload = raw.slice(0, dot);
  const presentedMac = raw.slice(dot + 1);

  let expectedMac: string;
  try {
    expectedMac = await txMac(payload, secret, info);
  } catch {
    return null;
  }
  // Constant-time — a MAC comparison must not leak a byte-by-byte prefix match.
  if (!timingSafeEqualString(expectedMac, presentedMac)) return null;

  try {
    const json = new TextDecoder().decode(b64urlToBytes(payload));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const tx = parsed as Partial<TxState>;
    if (tx.v !== 1) return null;
    if (
      typeof tx.s !== "string" ||
      typeof tx.n !== "string" ||
      typeof tx.cv !== "string" ||
      typeof tx.r !== "string" ||
      typeof tx.x !== "number"
    ) {
      return null;
    }
    return { v: 1, s: tx.s, n: tx.n, cv: tx.cv, r: tx.r, x: tx.x };
  } catch {
    return null;
  }
};

/**
 * Open-redirect guard. A `return_to` is only honoured when its ORIGIN is one we
 * already trust enough to echo in `Access-Control-Allow-Origin`. Checked on the
 * way in (so a bad link fails fast) AND on the way out — the MAC proves the
 * cookie is ours, not that the allowlist still holds, and an origin dropped
 * from the allowlist mid-transaction must stop being a destination.
 */
export function isAllowedReturnTo(returnTo: string, allowed: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return allowed.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}

export interface BeginLoginOptions {
  /**
   * Passed through as the `prompt` parameter. Only `create` is ever sent —
   * "Initiating User Registration via OpenID Connect 1.0", which asks the
   * issuer to lead with its sign-up screen. The caller allowlists the value
   * before it reaches here; nothing else, and `none` in particular, may cross
   * this seam from a query string.
   */
  prompt?: "create";
}

/**
 * Leg 1: mint PKCE + CSRF material, remember it in a cookie, and build the
 * `/authorize` URL. Returns `null` when `returnTo` is not an allowed origin —
 * the caller answers 400 rather than redirecting anywhere.
 */
export async function beginLogin(
  config: OidcConfig,
  returnTo: string,
  options: BeginLoginOptions = {},
): Promise<OidcStart | null> {
  if (!isAllowedReturnTo(returnTo, config.allowedReturnOrigins)) return null;

  const state = generateToken();
  const nonce = generateToken();
  const codeVerifier = generateToken();
  const codeChallenge = await sha256Base64Url(codeVerifier);

  const authorizeUrl = new URL("/authorize", config.issuer);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (options.prompt) authorizeUrl.searchParams.set("prompt", options.prompt);

  return {
    authorizeUrl: authorizeUrl.toString(),
    tx: await encodeTx(
      {
        v: 1,
        s: state,
        n: nonce,
        cv: codeVerifier,
        r: returnTo,
        x: Date.now() + TX_TTL_SECONDS * 1000,
      },
      config.clientSecret,
      config.txHmacInfo,
    ),
    txMaxAgeSeconds: TX_TTL_SECONDS,
  };
}

/**
 * The destination remembered in a transaction cookie, or `null` if the cookie
 * is missing, malformed, or names an origin we no longer allow. Used on the
 * issuer-said-no path, where there is no code to exchange but the browser
 * still has to land somewhere.
 */
export async function readReturnTo(config: OidcConfig, tx: string | null): Promise<string | null> {
  const state = tx ? await decodeTx(tx, config.clientSecret, config.txHmacInfo) : null;
  if (!state) return null;
  return isAllowedReturnTo(state.r, config.allowedReturnOrigins) ? state.r : null;
}

export interface CallbackInput {
  code: string | null;
  state: string | null;
  /** Raw transaction cookie value. */
  tx: string | null;
}

/**
 * Leg 2: match `state`, exchange the code, verify the ID token, and hand back
 * the identity to hang the product's own session on.
 */
export async function completeLogin(
  config: OidcConfig,
  input: CallbackInput,
): Promise<OidcComplete> {
  const tx = input.tx ? await decodeTx(input.tx, config.clientSecret, config.txHmacInfo) : null;
  // Re-validate the destination out of the cookie before it is used for
  // anything, including an error redirect.
  const returnTo = tx && isAllowedReturnTo(tx.r, config.allowedReturnOrigins) ? tx.r : null;

  if (!tx || !input.state) return { ok: false, reason: "state_mismatch", returnTo };
  if (tx.x <= Date.now()) return { ok: false, reason: "state_mismatch", returnTo };
  if (!timingSafeEqualString(tx.s, input.state)) {
    return { ok: false, reason: "state_mismatch", returnTo };
  }
  if (!input.code) return { ok: false, reason: "bad_request", returnTo };
  // Nowhere to land ⇒ nothing this exchange could accomplish. Bail before
  // spending the single-use code (and a round trip) on it.
  if (!returnTo) return { ok: false, reason: "bad_request", returnTo: null };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: tx.cv,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const doFetch = config._fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(new URL("/oidc/token", config.issuer).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return { ok: false, reason: "exchange_failed", returnTo };
  }
  if (!response.ok) return { ok: false, reason: "exchange_failed", returnTo };

  let payload: { id_token?: unknown };
  try {
    payload = (await response.json()) as { id_token?: unknown };
  } catch {
    return { ok: false, reason: "exchange_failed", returnTo };
  }
  const idToken = payload.id_token;
  if (typeof idToken !== "string") return { ok: false, reason: "exchange_failed", returnTo };

  const claims = await verifyIdToken(idToken, config.jwksUrl, {
    issuer: config.issuer,
    audience: config.clientId,
    nonce: tx.n,
    testKey: config._testKey,
  });
  if (!claims) return { ok: false, reason: "token_invalid", returnTo };

  // No profile id ⇒ the issuer does not treat us as first-party. Every row a
  // relying party owns is keyed on `usr_*`; there is nothing safe to do with a
  // pairwise subject alone, so refuse rather than invent an identity.
  if (!claims.osnProfileId) return { ok: false, reason: "token_invalid", returnTo };

  return {
    ok: true,
    returnTo,
    identity: {
      osnProfileId: claims.osnProfileId,
      osnSub: claims.sub,
      email: claims.email,
      handle: claims.handle,
      displayName: claims.displayName,
      avatarUrl: claims.avatarUrl,
    },
  };
}
