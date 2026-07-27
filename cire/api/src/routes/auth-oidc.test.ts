import { describe, it, expect, beforeAll } from "bun:test";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { beginLogin } from "../services/oidc-login";
import type { OidcConfig } from "../services/oidc-login";
import { appRequest } from "../test-helpers";
import {
  TEST_ISSUER,
  TEST_PROFILE_ID,
  TEST_RETURN_TO,
  makeOidcTestIssuer,
  stubTokenEndpoint,
  tokenResponse,
} from "../test-helpers/oidc-issuer";
import type { OidcTestIssuer } from "../test-helpers/oidc-issuer";

// Spelled out rather than imported: `lib/cookie.ts` keeps its names private, and
// a test that hard-codes the wire name catches a rename that would log everyone out.
const GUEST_COOKIE_NAME = "cire_session";
const ORGANISER_COOKIE_NAME = "cire_org_session";
const OIDC_TX_COOKIE_NAME = "cire_oidc_tx";

let issuer: OidcTestIssuer;
beforeAll(async () => {
  issuer = await makeOidcTestIssuer();
});

const freshDb = (): Db => {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
};

/** Reads one named cookie out of a response's repeated `Set-Cookie` headers. */
const setCookie = (res: Response, name: string): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

const cookieValue = (header: string): string => header.split(";")[0]!.split("=")[1]!;

/** Runs leg 1 for real, so the tx cookie and state always match production. */
async function startedTx(config: OidcConfig, returnTo = TEST_RETURN_TO) {
  const started = await beginLogin(config, returnTo);
  if (!started) throw new Error("beginLogin refused an allowed return_to");
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const nonce = new URL(started.authorizeUrl).searchParams.get("nonce")!;
  return { tx: started.tx, state, nonce };
}

/**
 * Signs an organiser in end-to-end and hands back their session cookie value,
 * the same way a browser would come out of the callback.
 */
async function signIn(
  db: Db,
  overrides: Parameters<OidcTestIssuer["signIdToken"]>[0] = {},
): Promise<string> {
  const config = issuer.config();
  const { tx, state, nonce } = await startedTx(config);
  const idToken = await issuer.signIdToken({ nonce, ...overrides });
  const app = createApp(db, {
    oidc: { ...config, _fetch: stubTokenEndpoint(() => tokenResponse(idToken)).fetch },
  });
  const res = await appRequest(app, `/api/auth/oidc/callback?code=c&state=${state}`, {
    headers: { cookie: `${OIDC_TX_COOKIE_NAME}=${tx}` },
  });
  expect(res.status).toBe(302);
  const cookie = setCookie(res, ORGANISER_COOKIE_NAME);
  if (!cookie) throw new Error("callback set no session cookie");
  return cookieValue(cookie);
}

describe("GET /api/auth/oidc/start", () => {
  it("answers 503 when the tier has no OIDC credentials", async () => {
    // `createApp`'s default — a tier that was never given a client secret must
    // not half-work; it must say sign-in is unavailable.
    const app = createApp(freshDb());
    const res = await appRequest(app, `/api/auth/oidc/start?return_to=${TEST_RETURN_TO}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sign_in_unavailable" });
  });

  it("rejects a return_to outside the allowlist without redirecting", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/oidc/start?return_to=https://evil.test/steal");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_return_to" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects a missing return_to", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/oidc/start");
    expect(res.status).toBe(400);
  });

  it("redirects to the issuer and remembers the transaction", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, `/api/auth/oidc/start?return_to=${TEST_RETURN_TO}`);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(TEST_ISSUER);
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const tx = setCookie(res, OIDC_TX_COOKIE_NAME)!;
    expect(tx).toContain("HttpOnly");
    // Lax, never Strict: the callback is a top-level cross-site navigation, and
    // Strict would drop this cookie on the way back in.
    expect(tx).toContain("SameSite=Lax");
    expect(tx).toContain("Path=/");
    expect(tx).toContain("Max-Age=600");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("carries prompt=create through to the issuer", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(
      app,
      `/api/auth/oidc/start?return_to=${TEST_RETURN_TO}&prompt=create`,
    );

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("prompt")).toBe("create");
  });

  it("drops any other prompt rather than forwarding it", async () => {
    // `none` is the one that matters: forwarded, it would ask the issuer for a
    // silent grant with no screen at all, from a query string anyone can write.
    const app = createApp(freshDb(), { oidc: issuer.config() });
    for (const prompt of ["none", "login", "select_account", "consent"]) {
      const res = await appRequest(
        app,
        `/api/auth/oidc/start?return_to=${TEST_RETURN_TO}&prompt=${prompt}`,
      );
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("prompt")).toBeNull();
    }
  });

  it("marks the cookie Secure on an https tier only", async () => {
    const insecure = createApp(freshDb(), { oidc: issuer.config() });
    const insecureRes = await appRequest(
      insecure,
      `/api/auth/oidc/start?return_to=${TEST_RETURN_TO}`,
    );
    expect(setCookie(insecureRes, OIDC_TX_COOKIE_NAME)).not.toContain("Secure");

    const webOrigin = "https://host.example.test";
    const secure = createApp(freshDb(), {
      webOrigin,
      oidc: issuer.config({ allowedReturnOrigins: [webOrigin] }),
    });
    const secureRes = await appRequest(secure, `/api/auth/oidc/start?return_to=${webOrigin}/`, {
      headers: { origin: webOrigin },
    });
    expect(setCookie(secureRes, OIDC_TX_COOKIE_NAME)).toContain("Secure");
  });
});

describe("GET /api/auth/oidc/callback", () => {
  it("answers 503 when the tier has no OIDC credentials", async () => {
    const app = createApp(freshDb());
    const res = await appRequest(app, "/api/auth/oidc/callback?code=c&state=s");
    expect(res.status).toBe(503);
  });

  it("sends the browser home with a marker when the issuer refused", async () => {
    const config = issuer.config();
    const { tx } = await startedTx(config);
    const app = createApp(freshDb(), { oidc: config });
    const res = await appRequest(app, "/api/auth/oidc/callback?error=access_denied", {
      headers: { cookie: `${OIDC_TX_COOKIE_NAME}=${tx}` },
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(TEST_RETURN_TO);
    expect(location.searchParams.get("auth_error")).toBe("sign_in_declined");
    // The issuer's own error string is unbounded outside text — never echoed.
    expect(res.headers.get("location")).not.toContain("access_denied");
    expect(setCookie(res, OIDC_TX_COOKIE_NAME)).toContain("Max-Age=0");
  });

  it("answers 400 when the issuer refused and there is no transaction to land", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/oidc/callback?error=access_denied");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sign_in_declined" });
    expect(setCookie(res, OIDC_TX_COOKIE_NAME)).toContain("Max-Age=0");
  });

  it("refuses a mismatched state and sets no session", async () => {
    const config = issuer.config();
    const { tx } = await startedTx(config);
    const app = createApp(freshDb(), { oidc: config });
    const res = await appRequest(app, "/api/auth/oidc/callback?code=c&state=forged", {
      headers: { cookie: `${OIDC_TX_COOKIE_NAME}=${tx}` },
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("auth_error")).toBe(
      "sign_in_failed",
    );
    expect(setCookie(res, ORGANISER_COOKIE_NAME)).toBeUndefined();
  });

  it("refuses a token with no osn_profile_id and sets no session", async () => {
    const config = issuer.config();
    const { tx, state, nonce } = await startedTx(config);
    const idToken = await issuer.signIdToken({ nonce, osnProfileId: null });
    const app = createApp(freshDb(), {
      oidc: { ...config, _fetch: stubTokenEndpoint(() => tokenResponse(idToken)).fetch },
    });
    const res = await appRequest(app, `/api/auth/oidc/callback?code=c&state=${state}`, {
      headers: { cookie: `${OIDC_TX_COOKIE_NAME}=${tx}` },
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("auth_error")).toBe(
      "sign_in_failed",
    );
    expect(setCookie(res, ORGANISER_COOKIE_NAME)).toBeUndefined();
  });

  it("sets the session cookie and lands on the remembered destination", async () => {
    const config = issuer.config();
    const { tx, state, nonce } = await startedTx(config);
    const idToken = await issuer.signIdToken({ nonce });
    const app = createApp(freshDb(), {
      oidc: { ...config, _fetch: stubTokenEndpoint(() => tokenResponse(idToken)).fetch },
    });
    const res = await appRequest(app, `/api/auth/oidc/callback?code=c&state=${state}`, {
      headers: { cookie: `${OIDC_TX_COOKIE_NAME}=${tx}` },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TEST_RETURN_TO);
    // A clean landing — no error marker for the frontend to act on.
    expect(res.headers.get("location")).not.toContain("auth_error");

    const session = setCookie(res, ORGANISER_COOKIE_NAME)!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(setCookie(res, OIDC_TX_COOKIE_NAME)).toContain("Max-Age=0");
  });
});

describe("GET /api/auth/session", () => {
  it("reports signed out rather than 401 when there is no cookie", async () => {
    // The organiser shell probes this on every page load; a signed-out visitor
    // is the expected case, not an error.
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it("reports signed out for a token that was never issued", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=nosuchtoken` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it("returns the profile snapshot for a live session", async () => {
    const db = freshDb();
    const token = await signIn(db);
    const app = createApp(db, { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["signedIn"]).toBe(true);
    expect(body["osnProfileId"]).toBe(TEST_PROFILE_ID);
    expect(body["email"]).toBe("organiser@example.test");
    expect(body["handle"]).toBe("organiser");
    expect(body["displayName"]).toBe("Test Organiser");
    expect(typeof body["expiresAt"]).toBe("string");
    // The pairwise subject is an internal join key, not something to hand out.
    expect(body["osnSub"]).toBeUndefined();
  });

  it("ignores a guest cookie — the two session systems do not cross", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${GUEST_COOKIE_NAME}=somethingelse` },
    });
    expect(await res.json()).toEqual({ signedIn: false });
  });
});

describe("POST /api/auth/signout", () => {
  it("kills the session and clears the cookie", async () => {
    const db = freshDb();
    const token = await signIn(db);
    const app = createApp(db, { oidc: issuer.config() });

    const out = await appRequest(app, "/api/auth/signout", {
      method: "POST",
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${token}` },
    });
    expect(out.status).toBe(200);
    expect(setCookie(out, ORGANISER_COOKIE_NAME)).toContain("Max-Age=0");

    // Even a browser that kept the cookie value is now signed out.
    const after = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${token}` },
    });
    expect(await after.json()).toEqual({ signedIn: false });
  });

  it("answers 200 with no cookie — signing out is idempotent", async () => {
    const app = createApp(freshDb(), { oidc: issuer.config() });
    const res = await appRequest(app, "/api/auth/signout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCookie(res, ORGANISER_COOKIE_NAME)).toContain("Max-Age=0");
  });

  it("leaves the other browser signed in by default", async () => {
    const db = freshDb();
    const browser = await signIn(db);
    const phone = await signIn(db);
    const app = createApp(db, { oidc: issuer.config() });

    await appRequest(app, "/api/auth/signout", {
      method: "POST",
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${browser}` },
    });

    const stillIn = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${phone}` },
    });
    expect(((await stillIn.json()) as Record<string, unknown>)["signedIn"]).toBe(true);
  });

  it("?all=1 signs every browser out", async () => {
    const db = freshDb();
    const browser = await signIn(db);
    const phone = await signIn(db);
    const app = createApp(db, { oidc: issuer.config() });

    const out = await appRequest(app, "/api/auth/signout?all=1", {
      method: "POST",
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${browser}` },
    });
    expect(out.status).toBe(200);

    for (const token of [browser, phone]) {
      const res = await appRequest(app, "/api/auth/session", {
        headers: { cookie: `${ORGANISER_COOKIE_NAME}=${token}` },
      });
      expect(await res.json()).toEqual({ signedIn: false });
    }
  });

  it("?all=1 spares a different organiser's sessions", async () => {
    const db = freshDb();
    const mine = await signIn(db);
    const theirs = await signIn(db, { osnProfileId: "usr_someone_else", sub: "pw_someone_else" });
    const app = createApp(db, { oidc: issuer.config() });

    await appRequest(app, "/api/auth/signout?all=1", {
      method: "POST",
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${mine}` },
    });

    const res = await appRequest(app, "/api/auth/session", {
      headers: { cookie: `${ORGANISER_COOKIE_NAME}=${theirs}` },
    });
    expect(((await res.json()) as Record<string, unknown>)["osnProfileId"]).toBe(
      "usr_someone_else",
    );
  });
});
