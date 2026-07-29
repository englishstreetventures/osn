import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { verifyIdToken } from "@shared/osn-auth-client/verify-id-token";

import { generateToken, sha256Base64Url } from "../lib/opaque-token";
import type { OrganiserIdentity } from "./organiser-session";

/**
 * OIDC relying-party half of organiser sign-in.
 *
 * cire used to run the passkey ceremony itself against `@osn/client`. It can't
 * any more: identity moved to its own zone (`musubi.social`) and a WebAuthn
 * ceremony may only run on an origin same-site with the RP ID, so
 * `host.cireweddings.com` cannot mint an OSN credential. Instead cire is a
 * plain OIDC relying party — redirect to the issuer's `/authorize`, take an
 * authorization code back, exchange it back-channel, and mint cire's OWN
 * session from the ID token.
 *
 * Two things about this flow are load-bearing:
 *
 * 1. **One registered redirect URI.** Three organiser-facing origins exist
 *    (`host.`, `vendor.`, `invite.`) but only `.../api/auth/oidc/callback` on
 *    the API host is registered with the issuer. The final destination rides in
 *    our own transaction state and is re-validated against the CORS allowlist
 *    on the way out, so the redirect URI stays a constant and there is no open
 *    redirect to hand the issuer.
 *
 * 2. **`osn_profile_id`, not `sub`.** The ID token's `sub` is the PAIRWISE
 *    subject — deliberately per-client and meaningless to the OSN graph. Every
 *    row cire owns (`weddings.owner_osn_profile_id`, `wedding_hosts`, all three
 *    ARC bridges) is keyed on the real `usr_*` profile id, which arrives only in
 *    the first-party `osn_profile_id` claim. A token without it is refused
 *    outright — falling back to `sub` would silently orphan every existing row.
 */

/** Scopes we ask for. `email` is separate consent; the organiser UI shows it. */
const SCOPE = "openid profile email";

/**
 * Ten minutes to get through the issuer's login + consent screens. Long enough
 * for a passkey prompt and a first-time consent read; short enough that a stale
 * transaction cookie left in a browser is worthless.
 */
const TX_TTL_SECONDS = 10 * 60;

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
  /** Test seam: skip the JWKS fetch and verify with this key. */
  _testKey?: CryptoKey;
  /** Test seam: injectable `fetch` for the back-channel token exchange. */
  _fetch?: typeof fetch;
}

/** What `/start` hands the route: where to send the browser, and what to remember. */
export interface OidcStart {
  authorizeUrl: string;
  /** Opaque cookie value — base64url JSON, safe for a Set-Cookie header. */
  tx: string;
  txMaxAgeSeconds: number;
}

export type OidcFailureReason =
  | "bad_request"
  | "state_mismatch"
  | "exchange_failed"
  | "token_invalid";

export type OidcComplete =
  | { ok: true; identity: OrganiserIdentity; returnTo: string }
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
// The `cire_oidc_tx` cookie carries the whole login transaction — `state`,
// `nonce`, PKCE verifier and return destination. It is host-scoped to cire-api,
// but a sibling `*.cireweddings.com` origin (or any code able to write a cookie
// the browser will send here) could otherwise PLANT a transaction of its own:
// a base64url JSON blob with no integrity protection is forgeable by anyone.
// A planted transaction fixates the victim's sign-in on the ATTACKER's `state`
// / `nonce` / verifier, so the code the victim's issuer mints exchanges into
// the attacker's identity and the victim ends up signed into the attacker's
// account (a classic OAuth session-fixation / login-CSRF).
//
// So the payload is authenticated: `<b64url(json)>.<b64url(hmac)>`, where the
// MAC is HMAC-SHA256 over the base64url PAYLOAD string under a key derived from
// a server-side secret. `decodeTx` recomputes the MAC and rejects on mismatch
// with a constant-time compare — a forged or tampered cookie decodes to `null`
// and the flow fails closed with `state_mismatch`.
//
// KEY: derived (HKDF-SHA256, fixed info string) from the OIDC client secret
// (`CIRE_OIDC_CLIENT_SECRET`) rather than reusing it raw — the client secret is
// already threaded into every place that touches this cookie (`OidcConfig`),
// present exactly when the OIDC routes are, and never leaves the server. No new
// secret to provision.
const TX_HMAC_INFO = new TextEncoder().encode("cire-oidc-tx-hmac-v1");

const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlToBytes = (raw: string): Uint8Array =>
  Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** HKDF-SHA256 derive a dedicated HMAC key from the OIDC client secret. */
async function deriveTxHmacKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: TX_HMAC_INFO },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** MAC over the base64url payload, as a base64url string. */
async function txMac(payload: string, secret: string): Promise<string> {
  const key = await deriveTxHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToB64url(new Uint8Array(sig));
}

export const encodeTx = async (state: TxState, secret: string): Promise<string> => {
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify(state)));
  const mac = await txMac(payload, secret);
  return `${payload}.${mac}`;
};

export const decodeTx = async (raw: string, secret: string): Promise<TxState | null> => {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const payload = raw.slice(0, dot);
  const presentedMac = raw.slice(dot + 1);

  let expectedMac: string;
  try {
    expectedMac = await txMac(payload, secret);
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
 * way in (so a bad link fails fast) AND on the way out (the transaction cookie
 * is unauthenticated — anything read back from it is untrusted input).
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
  const state = tx ? await decodeTx(tx, config.clientSecret) : null;
  if (!state) return null;
  return isAllowedReturnTo(state.r, config.allowedReturnOrigins) ? state.r : null;
}

export interface CallbackInput {
  code: string | null;
  state: string | null;
  /** Raw `cire_oidc_tx` cookie value. */
  tx: string | null;
}

/**
 * Leg 2: match `state`, exchange the code, verify the ID token, and hand back
 * the identity to hang a cire session on.
 *
 * Client authentication is **client_secret_post**, never Basic. The issuer's
 * token endpoint refuses a request that carries both (RFC 6749 §2.3), so
 * sending one and only one is not a style choice.
 */
export async function completeLogin(
  config: OidcConfig,
  input: CallbackInput,
): Promise<OidcComplete> {
  const tx = input.tx ? await decodeTx(input.tx, config.clientSecret) : null;
  // Re-validate the destination out of the untrusted cookie before it is used
  // for anything, including an error redirect.
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

  // No profile id ⇒ the issuer does not treat us as first-party. Every cire row
  // is keyed on `usr_*`; there is nothing safe to do with a pairwise subject
  // alone, so refuse rather than invent an identity.
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
