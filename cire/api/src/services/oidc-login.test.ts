import { describe, it, expect, beforeAll } from "bun:test";

import { sha256Base64Url } from "../lib/opaque-token";
import {
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_ISSUER,
  TEST_PAIRWISE_SUB,
  TEST_PROFILE_ID,
  TEST_REDIRECT_URI,
  TEST_RETURN_ORIGIN,
  TEST_RETURN_TO,
  makeOidcTestIssuer,
  stubTokenEndpoint,
  tokenResponse,
} from "../test-helpers/oidc-issuer";
import type { OidcTestIssuer } from "../test-helpers/oidc-issuer";
import {
  beginLogin,
  completeLogin,
  decodeTx,
  encodeTx,
  isAllowedReturnTo,
  readReturnTo,
} from "./oidc-login";
import type { OidcConfig } from "./oidc-login";

let issuer: OidcTestIssuer;
beforeAll(async () => {
  issuer = await makeOidcTestIssuer();
});

/**
 * Forge a tx cookie with an arbitrary (possibly invalid) payload shape but a
 * VALID HMAC, so a test exercises the payload-shape / expiry checks rather than
 * tripping the MAC check first. Reuses the production `encodeTx` (which signs)
 * with a cast so a v:9-style shape can be built.
 */
const forgeTx = (shape: Record<string, unknown>, secret: string): Promise<string> =>
  encodeTx(shape as unknown as Parameters<typeof encodeTx>[0], secret);

/** A started login: the decoded tx plus the `state` the issuer would echo back. */
async function startLogin(config: OidcConfig, returnTo = TEST_RETURN_TO) {
  const started = await beginLogin(config, returnTo);
  if (!started) throw new Error("beginLogin refused an allowed return_to");
  const tx = await decodeTx(started.tx, config.clientSecret);
  if (!tx) throw new Error("decodeTx rejected a freshly minted transaction");
  return { started, tx, cookie: started.tx };
}

describe("isAllowedReturnTo", () => {
  const allowed = [TEST_RETURN_ORIGIN, "https://host.example.test"];

  it("accepts any path or query on an allowlisted origin", () => {
    expect(isAllowedReturnTo(TEST_RETURN_ORIGIN, allowed)).toBe(true);
    expect(isAllowedReturnTo(`${TEST_RETURN_ORIGIN}/weddings?tab=guests`, allowed)).toBe(true);
    expect(isAllowedReturnTo("https://host.example.test/deep/path#frag", allowed)).toBe(true);
  });

  it("rejects an origin that is not on the list", () => {
    expect(isAllowedReturnTo("https://evil.test/", allowed)).toBe(false);
    // Suffix confusion — `evil-host.example.test` is a different origin.
    expect(isAllowedReturnTo("https://evil-host.example.test/", allowed)).toBe(false);
    // Same host, different scheme and port are different origins too.
    expect(isAllowedReturnTo("http://host.example.test/", allowed)).toBe(false);
    expect(isAllowedReturnTo("https://host.example.test:8443/", allowed)).toBe(false);
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(isAllowedReturnTo("javascript:alert(1)", allowed)).toBe(false);
    expect(isAllowedReturnTo("data:text/html,x", allowed)).toBe(false);
    expect(isAllowedReturnTo("/weddings", allowed)).toBe(false);
    expect(isAllowedReturnTo("", allowed)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(isAllowedReturnTo(TEST_RETURN_TO, [])).toBe(false);
  });
});

describe("beginLogin", () => {
  it("refuses a return_to outside the allowlist", async () => {
    expect(await beginLogin(issuer.config(), "https://evil.test/steal")).toBeNull();
    expect(await beginLogin(issuer.config(), "")).toBeNull();
  });

  it("builds an authorize URL with the registered client and redirect URI", async () => {
    const { started } = await startLogin(issuer.config());
    const url = new URL(started.authorizeUrl);
    expect(url.origin).toBe(TEST_ISSUER);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(TEST_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });

  it("sends the S256 challenge for the verifier it remembers (PKCE)", async () => {
    const { started, tx } = await startLogin(issuer.config());
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await sha256Base64Url(tx.cv));
    // Plain would be the verifier itself — make sure it is not.
    expect(url.searchParams.get("code_challenge")).not.toBe(tx.cv);
  });

  it("echoes its state and nonce into the URL and remembers both", async () => {
    const { started, tx } = await startLogin(issuer.config());
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get("state")).toBe(tx.s);
    expect(url.searchParams.get("nonce")).toBe(tx.n);
    // The nonce never rides in the URL as the state, and vice versa.
    expect(tx.s).not.toBe(tx.n);
  });

  it("mints fresh state, nonce and verifier on every call", async () => {
    const a = await startLogin(issuer.config());
    const b = await startLogin(issuer.config());
    expect(a.tx.s).not.toBe(b.tx.s);
    expect(a.tx.n).not.toBe(b.tx.n);
    expect(a.tx.cv).not.toBe(b.tx.cv);
  });

  it("remembers the destination and expires the transaction in ten minutes", async () => {
    const before = Date.now();
    const { started, tx } = await startLogin(issuer.config(), `${TEST_RETURN_ORIGIN}/weddings/x`);
    expect(tx.v).toBe(1);
    expect(tx.r).toBe(`${TEST_RETURN_ORIGIN}/weddings/x`);
    expect(started.txMaxAgeSeconds).toBe(600);
    expect(tx.x).toBeGreaterThanOrEqual(before + 600_000);
    expect(tx.x).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("produces a cookie-safe transaction value", async () => {
    const { cookie } = await startLogin(issuer.config());
    // `payload.mac` — base64url segments joined by a dot, all cookie-safe.
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("readReturnTo", () => {
  it("returns the remembered destination", async () => {
    const config = issuer.config();
    const { cookie } = await startLogin(config, `${TEST_RETURN_ORIGIN}/vendors`);
    expect(await readReturnTo(config, cookie)).toBe(`${TEST_RETURN_ORIGIN}/vendors`);
  });

  it("returns null for a missing or malformed cookie", async () => {
    const config = issuer.config();
    expect(await readReturnTo(config, null)).toBeNull();
    expect(await readReturnTo(config, "not-base64url-json")).toBeNull();
    // Wrong schema version, even with a valid MAC.
    expect(
      await readReturnTo(
        config,
        await forgeTx({ v: 9, s: "", n: "", cv: "", r: "", x: 0 }, config.clientSecret),
      ),
    ).toBeNull();
  });

  it("returns null when the remembered origin is no longer allowed", async () => {
    const { cookie } = await startLogin(issuer.config());
    // Same cookie, a config whose allowlist has since dropped that origin.
    const narrowed = issuer.config({ allowedReturnOrigins: ["https://other.test"] });
    expect(await readReturnTo(narrowed, cookie)).toBeNull();
  });
});

describe("tx cookie integrity (HMAC)", () => {
  const state = { v: 1 as const, s: "st", n: "no", cv: "cv", r: TEST_RETURN_TO, x: Date.now() };

  it("round-trips a freshly signed transaction", async () => {
    const secret = TEST_CLIENT_SECRET;
    const decoded = await decodeTx(await encodeTx(state, secret), secret);
    expect(decoded).toEqual(state);
  });

  it("carries a MAC — the value is `<payload>.<mac>`", async () => {
    const cookie = await encodeTx(state, TEST_CLIENT_SECRET);
    expect(cookie.split(".")).toHaveLength(2);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a tampered payload (session-fixation guard)", async () => {
    const secret = TEST_CLIENT_SECRET;
    const cookie = await encodeTx(state, secret);
    const [payload, mac] = cookie.split(".");
    // Re-point the return destination while keeping the original MAC.
    const forgedPayload = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ ...state, s: "attacker" }))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await decodeTx(`${forgedPayload}.${mac}`, secret)).toBeNull();
    // A flipped MAC is rejected too.
    const flipped = mac!.slice(0, -1) + (mac!.endsWith("A") ? "B" : "A");
    expect(await decodeTx(`${payload}.${flipped}`, secret)).toBeNull();
  });

  it("rejects a cookie signed under a different secret", async () => {
    const cookie = await encodeTx(state, "secret-one");
    expect(await decodeTx(cookie, "secret-two")).toBeNull();
  });

  it("rejects an unsigned legacy cookie (no MAC segment)", async () => {
    // The old format was bare base64url JSON with no `.mac` — a hard cutover.
    const bare = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(state))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await decodeTx(bare, TEST_CLIENT_SECRET)).toBeNull();
  });
});

describe("completeLogin — transaction checks", () => {
  it("fails with state_mismatch when there is no transaction cookie", async () => {
    const result = await completeLogin(issuer.config(), { code: "c", state: "s", tx: null });
    expect(result).toEqual({ ok: false, reason: "state_mismatch", returnTo: null });
  });

  it("fails with state_mismatch when the issuer echoed no state", async () => {
    const config = issuer.config();
    const { cookie } = await startLogin(config);
    const result = await completeLogin(config, { code: "c", state: null, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("state_mismatch");
    // The destination still comes back so the browser can be sent somewhere.
    expect(result.returnTo).toBe(TEST_RETURN_TO);
  });

  it("fails with state_mismatch when the echoed state is wrong", async () => {
    const config = issuer.config();
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, {
      code: "c",
      state: `${tx.s}x`,
      tx: cookie,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("state_mismatch");
  });

  it("fails with state_mismatch once the transaction has expired", async () => {
    const config = issuer.config();
    const { tx } = await startLogin(config);
    const stale = await encodeTx({ ...tx, x: Date.now() - 1_000 }, config.clientSecret);
    const result = await completeLogin(config, { code: "c", state: tx.s, tx: stale });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("state_mismatch");
  });

  it("fails with bad_request when the issuer sent no code", async () => {
    const config = issuer.config();
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, { code: null, state: tx.s, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("bad_request");
  });

  it("refuses without exchanging when the cookie names a disallowed origin", async () => {
    const { cookie, tx } = await startLogin(issuer.config());
    // Allowlist has since dropped that origin — the state still matches, so the
    // only thing stopping this is the re-validation on the way out.
    const stub = stubTokenEndpoint(() => new Response(null, { status: 200 }));
    const narrowed = issuer.config({
      allowedReturnOrigins: ["https://other.test"],
      _fetch: stub.fetch,
    });
    const result = await completeLogin(narrowed, { code: "c", state: tx.s, tx: cookie });
    expect(result).toEqual({ ok: false, reason: "bad_request", returnTo: null });
    // The single-use code is never spent on a login that could not land.
    expect(stub.calls).toHaveLength(0);
  });
});

describe("completeLogin — token exchange", () => {
  it("posts the code, verifier and client credentials in the body", async () => {
    const started = await startLogin(issuer.config());
    const { cookie, tx } = started;
    const stub = stubTokenEndpoint(async () =>
      tokenResponse(await issuer.signIdToken({ nonce: tx.n })),
    );
    const config = issuer.config({ _fetch: stub.fetch });
    const result = await completeLogin(config, { code: "the-code", state: tx.s, tx: cookie });
    expect(result.ok).toBe(true);

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call!.url).toBe(`${TEST_ISSUER}/oidc/token`);
    expect(call!.params.get("grant_type")).toBe("authorization_code");
    expect(call!.params.get("code")).toBe("the-code");
    expect(call!.params.get("code_verifier")).toBe(tx.cv);
    expect(call!.params.get("redirect_uri")).toBe(TEST_REDIRECT_URI);
    expect(call!.params.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(call!.params.get("client_secret")).toBe(TEST_CLIENT_SECRET);
    expect(call!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    // client_secret_post ONLY — the issuer rejects a request carrying both
    // forms of client authentication (RFC 6749 §2.3).
    expect(call!.headers.get("authorization")).toBeNull();
  });

  it("fails with exchange_failed when the token endpoint refuses", async () => {
    const stub = stubTokenEndpoint(() => new Response("nope", { status: 400 }));
    const config = issuer.config({ _fetch: stub.fetch });
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, { code: "c", state: tx.s, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exchange_failed");
    expect(result.returnTo).toBe(TEST_RETURN_TO);
  });

  it("fails with exchange_failed when the token endpoint is unreachable", async () => {
    const stub = stubTokenEndpoint(() => {
      throw new TypeError("network down");
    });
    const config = issuer.config({ _fetch: stub.fetch });
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, { code: "c", state: tx.s, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exchange_failed");
  });

  it("fails with exchange_failed on a non-JSON body", async () => {
    const stub = stubTokenEndpoint(() => new Response("<html>", { status: 200 }));
    const config = issuer.config({ _fetch: stub.fetch });
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, { code: "c", state: tx.s, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exchange_failed");
  });

  it("fails with exchange_failed when the response carries no id_token", async () => {
    const stub = stubTokenEndpoint(
      () =>
        new Response(JSON.stringify({ access_token: "at" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const config = issuer.config({ _fetch: stub.fetch });
    const { cookie, tx } = await startLogin(config);
    const result = await completeLogin(config, { code: "c", state: tx.s, tx: cookie });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exchange_failed");
  });
});

describe("completeLogin — ID token verification", () => {
  /** Runs a full leg-2 with an ID token built from the live transaction. */
  async function completeWith(
    overrides: Parameters<OidcTestIssuer["signIdToken"]>[0] = {},
    configOverrides: Partial<OidcConfig> = {},
  ) {
    const config = issuer.config(configOverrides);
    const { cookie, tx } = await startLogin(config);
    const idToken = await issuer.signIdToken({ nonce: tx.n, ...overrides });
    const exchange = stubTokenEndpoint(() => tokenResponse(idToken));
    return completeLogin(
      { ...config, _fetch: exchange.fetch },
      { code: "c", state: tx.s, tx: cookie },
    );
  }

  it("returns the identity from a good token", async () => {
    const result = await completeWith();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.returnTo).toBe(TEST_RETURN_TO);
    expect(result.identity).toEqual({
      osnProfileId: TEST_PROFILE_ID,
      osnSub: TEST_PAIRWISE_SUB,
      email: "organiser@example.test",
      handle: "organiser",
      displayName: "Test Organiser",
      avatarUrl: "https://cdn.test.invalid/a.png",
    });
  });

  it("keeps the pairwise sub and the profile id apart", async () => {
    const result = await completeWith({ sub: "pw_someone_else" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // `sub` is per-client and meaningless to the graph; every cire row is keyed
    // on the `usr_*` id, which must come from `osn_profile_id` alone.
    expect(result.identity.osnSub).toBe("pw_someone_else");
    expect(result.identity.osnProfileId).toBe(TEST_PROFILE_ID);
  });

  it("tolerates a token with no profile scope claims", async () => {
    const result = await completeWith({
      email: null,
      handle: null,
      displayName: null,
      avatarUrl: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.identity.email).toBeNull();
    expect(result.identity.handle).toBeNull();
    expect(result.identity.displayName).toBeNull();
    expect(result.identity.avatarUrl).toBeNull();
  });

  it("refuses a token with no osn_profile_id (not first-party)", async () => {
    const result = await completeWith({ osnProfileId: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses a token minted for another client", async () => {
    const result = await completeWith({ audience: "cid_someone_else" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses a token from another issuer", async () => {
    const result = await completeWith({ issuer: "https://evil.test" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses an expired token", async () => {
    const result = await completeWith({ expiresIn: "-5m" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses a replayed token whose nonce belongs to another transaction", async () => {
    const config = issuer.config();
    const first = await startLogin(config);
    const second = await startLogin(config);
    // Token minted for the FIRST transaction, presented against the second.
    const idToken = await issuer.signIdToken({ nonce: first.tx.n });
    const exchange = stubTokenEndpoint(() => tokenResponse(idToken));
    const result = await completeLogin(
      { ...config, _fetch: exchange.fetch },
      { code: "c", state: second.tx.s, tx: second.cookie },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses a token with no nonce at all", async () => {
    const config = issuer.config();
    const { cookie, tx } = await startLogin(config);
    const idToken = await issuer.signIdToken();
    const exchange = stubTokenEndpoint(() => tokenResponse(idToken));
    const result = await completeLogin(
      { ...config, _fetch: exchange.fetch },
      { code: "c", state: tx.s, tx: cookie },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });

  it("refuses a token signed by a key that is not the issuer's", async () => {
    const impostor = await makeOidcTestIssuer();
    const config = issuer.config();
    const { cookie, tx } = await startLogin(config);
    const idToken = await impostor.signIdToken({ nonce: tx.n });
    const exchange = stubTokenEndpoint(() => tokenResponse(idToken));
    const result = await completeLogin(
      { ...config, _fetch: exchange.fetch },
      { code: "c", state: tx.s, tx: cookie },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("token_invalid");
  });
});
