import type { Db } from "@pulse/db/service";
import type { OidcConfig } from "@shared/osn-auth-client/oidc-rp";
import {
  makeOidcTestIssuer,
  stubTokenEndpoint,
  tokenResponse,
  TEST_PAIRWISE_SUB,
  TEST_PROFILE_ID,
  type OidcTestIssuer,
  type TokenEndpointCall,
} from "@shared/osn-auth-client/testing/oidc-issuer";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Layer, ManagedRuntime } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthRoutes } from "../../src/routes/auth";
import { webSessionService, type WebIdentity } from "../../src/services/webSession";
import { createTestLayer } from "../helpers/db";

/**
 * The Pulse web sign-in surface end to end. Both OIDC legs run against the
 * shared fake issuer (`@shared/osn-auth-client/testing/oidc-issuer`) — no
 * socket is touched: `_testKey` stands in for the JWKS fetch and `_fetch` for
 * the back-channel exchange.
 *
 * Per-IP limiting keys on `x-forwarded-for` here, with `trustedProxyCount: 1`:
 * under `app.handle(...)` there is no socket peer, and the policy is
 * fail-closed, so a request with no forwarded IP is denied (S-M34).
 */

const RETURN_ORIGIN = "https://pulse.test.invalid";
const RETURN_TO = `${RETURN_ORIGIN}/home`;
const LOGIN_FALLBACK = `${RETURN_ORIGIN}/login`;
const PROXIED = { trustedProxyCount: 1 } as const;
const IP_HEADER = { "x-forwarded-for": "203.0.113.7" };

const allow: RateLimiterBackend = { check: () => true };
const block: RateLimiterBackend = { check: () => false };

let issuer: OidcTestIssuer;

beforeAll(async () => {
  issuer = await makeOidcTestIssuer({ returnOrigin: RETURN_ORIGIN });
});

interface HarnessOptions {
  /** `null` models a tier with no OIDC credentials configured. */
  oidc?: OidcConfig | null;
  startLimiter?: RateLimiterBackend;
  sessionLimiter?: RateLimiterBackend;
  secureCookies?: boolean;
  respond?: (call: TokenEndpointCall) => Response | Promise<Response>;
}

/**
 * One app plus a runtime over the SAME layer, so a test can mint sessions
 * directly and have the routes see them (`createTestLayer` is a
 * `Layer.succeed` over one in-memory DB).
 */
const harness = (options: HarnessOptions = {}) => {
  const layer: Layer.Layer<Db> = createTestLayer();
  // Filled in by the test before the callback leg runs — the ID token has to
  // carry the nonce that `/oidc/start` minted, which is not known until then.
  const idToken = { value: "" };
  const stub = stubTokenEndpoint(options.respond ?? (() => tokenResponse(idToken.value)));
  const oidc = options.oidc === undefined ? issuer.config({ _fetch: stub.fetch }) : options.oidc;

  const app = createAuthRoutes(layer, {
    oidc,
    secureCookies: options.secureCookies ?? true,
    loginFallbackUrl: LOGIN_FALLBACK,
    startLimiter: options.startLimiter ?? allow,
    sessionLimiter: options.sessionLimiter ?? allow,
    clientIpConfig: PROXIED,
  });

  return { app, runtime: ManagedRuntime.make(layer), idToken, stub };
};

type App = ReturnType<typeof harness>["app"];

const get = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { ...IP_HEADER, ...headers } }));

const post = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { ...IP_HEADER, ...headers },
    }),
  );

/** The `name=value` pair of one Set-Cookie on a response, ready to send back. */
const cookieFrom = (res: Response, name: string): string | null => {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header ? (header.split(";")[0] ?? null) : null;
};

/** Run leg 1 and hand back everything leg 2 needs. */
const startLogin = async (app: App, query = `?return_to=${encodeURIComponent(RETURN_TO)}`) => {
  const res = await get(app, `/api/auth/oidc/start${query}`);
  expect(res.status).toBe(302);
  const authorizeUrl = new URL(res.headers.get("location") ?? "");
  const cookie = cookieFrom(res, "pulse_oidc_tx");
  expect(cookie).not.toBeNull();
  return {
    res,
    authorizeUrl,
    cookie: cookie ?? "",
    state: authorizeUrl.searchParams.get("state") ?? "",
    nonce: authorizeUrl.searchParams.get("nonce") ?? "",
  };
};

const identity: WebIdentity = {
  osnProfileId: "usr_alice",
  osnSub: "pairwise-sub-for-pulse",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  avatarUrl: null,
};

// ---------------------------------------------------------------------------
// GET /api/auth/oidc/start
// ---------------------------------------------------------------------------

describe("GET /api/auth/oidc/start", () => {
  it("redirects to the issuer with PKCE and remembers the transaction", async () => {
    const { app } = harness();
    const { authorizeUrl, res } = await startLogin(app);

    expect(authorizeUrl.origin).toBe("https://id.test.invalid");
    expect(authorizeUrl.pathname).toBe("/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("cid_test");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy();
    // `return_to` rides in our own transaction, never in the redirect URI —
    // the issuer only ever sees the one registered callback.
    expect(authorizeUrl.searchParams.get("redirect_uri")).not.toContain("return_to");

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("pulse_oidc_tx="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards prompt=create and drops every other prompt value", async () => {
    const { app } = harness();
    const created = await startLogin(
      app,
      `?return_to=${encodeURIComponent(RETURN_TO)}&prompt=create`,
    );
    expect(created.authorizeUrl.searchParams.get("prompt")).toBe("create");

    // `prompt=none` asks for a silent grant. The query string is
    // attacker-reachable, so anything but `create` is dropped, not forwarded.
    const silent = await startLogin(app, `?return_to=${encodeURIComponent(RETURN_TO)}&prompt=none`);
    expect(silent.authorizeUrl.searchParams.get("prompt")).toBeNull();
  });

  it("400s a return_to outside the allowlist rather than starting a login", async () => {
    const { app } = harness();
    const res = await get(app, "/api/auth/oidc/start?return_to=https%3A%2F%2Fevil.test%2Fsteal");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_return_to" });
    expect(cookieFrom(res, "pulse_oidc_tx")).toBeNull();
  });

  it("bounces to the login page when the tier has no OIDC credentials", async () => {
    const { app } = harness({ oidc: null });
    const res = await get(app, `/api/auth/oidc/start?return_to=${encodeURIComponent(RETURN_TO)}`);
    expect(res.status).toBe(302);
    // A top-level navigation must land on a page, not on a JSON error body.
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(LOGIN_FALLBACK);
    expect(location.searchParams.get("auth_error")).toBe("sign_in_unavailable");
  });

  it("429s over the per-IP ceiling, and with no resolvable IP at all", async () => {
    const { app } = harness({ startLimiter: block });
    const limited = await get(
      app,
      `/api/auth/oidc/start?return_to=${encodeURIComponent(RETURN_TO)}`,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });

    const { app: open } = harness();
    const unresolved = await open.handle(
      new Request(
        `http://localhost/api/auth/oidc/start?return_to=${encodeURIComponent(RETURN_TO)}`,
      ),
    );
    expect(unresolved.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/oidc/callback
// ---------------------------------------------------------------------------

describe("GET /api/auth/oidc/callback", () => {
  it("exchanges the code and lands the browser back with a session cookie", async () => {
    const { app, idToken, stub } = harness();
    const { state, nonce, cookie } = await startLogin(app);
    idToken.value = await issuer.signIdToken({ nonce });

    const res = await get(app, `/api/auth/oidc/callback?code=abc&state=${state}`, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RETURN_TO);
    expect(stub.calls).toHaveLength(1);

    const session = cookieFrom(res, "pulse_web_session");
    expect(session).toMatch(/^pulse_web_session=.+/);
    const sessionHeader = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("pulse_web_session="));
    expect(sessionHeader).toContain("Max-Age=604800");
    expect(sessionHeader).toContain("HttpOnly");
    // Spent transaction: single-use by construction, so it goes with the reply.
    expect(res.headers.getSetCookie()).toContainEqual(expect.stringContaining("pulse_oidc_tx=;"));

    // The cookie it minted really signs the browser in, and on the profile id
    // rather than the pairwise subject.
    const probe = await get(app, "/api/auth/session", { cookie: session ?? "" });
    expect(await probe.json()).toMatchObject({
      signedIn: true,
      osnProfileId: TEST_PROFILE_ID,
      email: "person@example.test",
      handle: "person",
    });
    expect(TEST_PROFILE_ID).not.toBe(TEST_PAIRWISE_SUB);
  });

  it("reports a refusal from the issuer without echoing its error string", async () => {
    const { app } = harness();
    const { cookie } = await startLogin(app);

    const res = await get(
      app,
      "/api/auth/oidc/callback?error=access_denied&error_description=user%20said%20no",
      { cookie },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    // Back to where the login started, since the transaction still names it.
    expect(location.origin + location.pathname).toBe(RETURN_TO);
    expect(location.searchParams.get("auth_error")).toBe("sign_in_declined");
    expect(location.search).not.toContain("access_denied");
    expect(cookieFrom(res, "pulse_web_session")).toBeNull();
  });

  it("refuses a state that does not match the transaction cookie", async () => {
    const { app, stub } = harness();
    const { cookie } = await startLogin(app);

    const res = await get(app, "/api/auth/oidc/callback?code=abc&state=not-the-state", { cookie });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("sign_in_failed");
    // The code is never spent on a transaction that failed its CSRF binding.
    expect(stub.calls).toHaveLength(0);
    expect(cookieFrom(res, "pulse_web_session")).toBeNull();
  });

  it("falls back to the login page when there is no transaction cookie", async () => {
    const { app } = harness();
    const res = await get(app, "/api/auth/oidc/callback?code=abc&state=whatever");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(LOGIN_FALLBACK);
    expect(location.searchParams.get("auth_error")).toBe("sign_in_failed");
  });

  it("refuses an ID token with no osn_profile_id claim", async () => {
    const { app, idToken } = harness();
    const { state, nonce, cookie } = await startLogin(app);
    // A pairwise subject alone names nothing in the OSN graph.
    idToken.value = await issuer.signIdToken({ nonce, osnProfileId: null });

    const res = await get(app, `/api/auth/oidc/callback?code=abc&state=${state}`, { cookie });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("sign_in_failed");
    expect(cookieFrom(res, "pulse_web_session")).toBeNull();
  });

  it("refuses an ID token minted for a different nonce", async () => {
    const { app, idToken } = harness();
    const { state, cookie } = await startLogin(app);
    idToken.value = await issuer.signIdToken({ nonce: "some-other-login" });

    const res = await get(app, `/api/auth/oidc/callback?code=abc&state=${state}`, { cookie });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("sign_in_failed");
    expect(cookieFrom(res, "pulse_web_session")).toBeNull();
  });

  it("bounces to the login page when the tier has no OIDC credentials", async () => {
    const { app } = harness({ oidc: null });
    const res = await get(app, "/api/auth/oidc/callback?code=abc&state=x");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("sign_in_unavailable");
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/session
// ---------------------------------------------------------------------------

describe("GET /api/auth/session", () => {
  it("answers 200 `signedIn: false` for a visitor, not 401", async () => {
    // Every page load runs this probe; a signed-out visitor is the expected
    // case, not an error.
    const { app } = harness();
    const res = await get(app, "/api/auth/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it("returns the login-time snapshot for a live session", async () => {
    const { app, runtime } = harness();
    const created = await runtime.runPromise(webSessionService.create(identity));

    const res = await get(app, "/api/auth/session", {
      cookie: `pulse_web_session=${created.token}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      signedIn: true,
      osnProfileId: "usr_alice",
      email: "alice@example.com",
      handle: "alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    expect(new Date(String(body["expiresAt"])).getTime()).toBeGreaterThan(Date.now());
    // The opaque token is never handed back to the page.
    expect(JSON.stringify(body)).not.toContain(created.token);
  });

  it("answers `signedIn: false` for an unknown or expired cookie", async () => {
    const { app, runtime } = harness();
    const stale = await runtime.runPromise(webSessionService.create(identity, -1));

    expect(
      await (await get(app, "/api/auth/session", { cookie: "pulse_web_session=nope" })).json(),
    ).toEqual({ signedIn: false });
    expect(
      await (
        await get(app, "/api/auth/session", { cookie: `pulse_web_session=${stale.token}` })
      ).json(),
    ).toEqual({ signedIn: false });
  });

  it("429s over the per-IP ceiling", async () => {
    const { app } = harness({ sessionLimiter: block });
    const res = await get(app, "/api/auth/session");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/signout
// ---------------------------------------------------------------------------

describe("POST /api/auth/signout", () => {
  it("clears the cookie and drops the session row", async () => {
    const { app, runtime } = harness();
    const created = await runtime.runPromise(webSessionService.create(identity));
    const cookie = `pulse_web_session=${created.token}`;

    const res = await post(app, "/api/auth/signout", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("pulse_web_session="));
    expect(cleared).toContain("pulse_web_session=;");
    expect(cleared).toContain("Max-Age=0");

    // Not just the browser's copy — the row itself is gone.
    expect(await (await get(app, "/api/auth/session", { cookie })).json()).toEqual({
      signedIn: false,
    });
  });

  it("answers 200 with no cookie, and for a token that was never issued", async () => {
    // Signing out is idempotent, and saying whether a token was live would be
    // a free oracle.
    const { app } = harness();
    expect((await post(app, "/api/auth/signout")).status).toBe(200);

    const unknown = await post(app, "/api/auth/signout", {
      cookie: "pulse_web_session=never-issued",
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });
  });

  it("?all=1 signs the profile out of every browser", async () => {
    const { app, runtime } = harness();
    const here = await runtime.runPromise(webSessionService.create(identity));
    const elsewhere = await runtime.runPromise(webSessionService.create(identity));
    const other = await runtime.runPromise(
      webSessionService.create({ ...identity, osnProfileId: "usr_bob" }),
    );

    const res = await post(app, "/api/auth/signout?all=1", {
      cookie: `pulse_web_session=${here.token}`,
    });
    expect(res.status).toBe(200);

    for (const token of [here.token, elsewhere.token]) {
      expect(
        await (
          await get(app, "/api/auth/session", { cookie: `pulse_web_session=${token}` })
        ).json(),
      ).toEqual({ signedIn: false });
    }
    // Another profile's sessions are untouched.
    expect(
      await (
        await get(app, "/api/auth/session", { cookie: `pulse_web_session=${other.token}` })
      ).json(),
    ).toMatchObject({ signedIn: true, osnProfileId: "usr_bob" });
  });

  it("429s over the per-IP ceiling", async () => {
    const { app } = harness({ sessionLimiter: block });
    const res = await post(app, "/api/auth/signout");
    expect(res.status).toBe(429);
  });
});
