/**
 * Sign out everywhere else, and revoking the cire connection, end the
 * account's cire organiser sessions through cire-api's back-channel
 * (`POST /internal/revoke-organiser-sessions`).
 *
 * The call runs in the background: each request here runs inside
 * `withBackgroundSink`, as the Worker entry runs it, and the test awaits what
 * the request handed to `waitUntil` before it looks at what reached cire.
 * cire itself is a spy on `globalThis.fetch`, which `instrumentedFetch` calls;
 * the E2E flow `cire-registry-money` drives the real cire route.
 */

import { Logger } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { withBackgroundSink } from "../../src/lib/background";
import { hashSessionToken } from "../../src/services/auth/helpers";
import type { CireOrganiserRevokeConfig } from "../../src/services/cire-organiser-revoke";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
// Wrapped factory (trust XFF under app.handle). See helpers/routes.
import { createAuthRoutes } from "../helpers/routes";

const CIRE_URL = "https://cire-api.test";
const SECRET = "cire-revoke-secret-for-tests-0123456789abcdef";
const CIRE_CLIENT_ID = "cid_cire";

const CONFIGURED: CireOrganiserRevokeConfig = {
  url: CIRE_URL,
  secret: SECRET,
  clientId: CIRE_CLIENT_ID,
};

interface LogLine {
  readonly level: string;
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

interface CireCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Replaces `globalThis.fetch` with cire answering `respond`, recording each call. */
function fakeCire(respond: () => Promise<Response> = async () => Response.json({ ok: true })) {
  const calls: CireCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return respond();
  });
  return calls;
}

function setup(cire: CireOrganiserRevokeConfig = CONFIGURED) {
  const { layer, sqlite, email } = createTestLayerWithSqlite();
  const logs: LogLine[] = [];
  const loggerLayer = Logger.layer([
    Logger.map(Logger.formatStructured, (line) => {
      logs.push(line);
    }),
  ]);
  const app = createAuthRoutes(
    config,
    layer,
    loggerLayer,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    null,
    cire,
  );

  /** One request, run the way the Worker entry runs it; resolves once its background work settles. */
  async function send(request: Request): Promise<Response> {
    const handed: Promise<unknown>[] = [];
    const response = await withBackgroundSink({ waitUntil: (p) => handed.push(p) }, async () =>
      app.handle(request),
    );
    await Promise.all(handed);
    return response;
  }

  /** Registers an account; returns its cookie, access token, account id and profile id. */
  async function register(emailAddress: string, handle: string) {
    await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailAddress, handle, birthdate: "1990-01-01" }),
      }),
    );
    const code = email
      .recorded()
      .toReversed()
      .map((m) => m.text.match(/code is: (\d{6})/)?.[1])
      .find((c) => c !== undefined);
    const res = await app.handle(
      new Request("http://localhost/register/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailAddress, code }),
      }),
    );
    const body = (await res.json()) as { session: { access_token: string } };
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("osn_session=");
    const row = sqlite
      .query<{ id: string; account_id: string }, [string]>(
        "SELECT id, account_id FROM users WHERE handle = ?",
      )
      .get(handle);
    if (!row) throw new Error(`no profile for ${handle}`);
    return {
      cookie,
      accessToken: body.session.access_token,
      accountId: row.account_id,
      profileId: row.id,
    };
  }

  /** Gives `accountId` another live profile, as `POST /profiles/create` would. */
  function addProfile(accountId: string, id: string, handle: string): void {
    const now = Math.floor(Date.now() / 1000);
    sqlite.run(
      `INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      [id, accountId, handle, now, now],
    );
  }

  function grantConsent(accountId: string, profileId: string, clientId: string): void {
    sqlite.run(
      `INSERT INTO oauth_consents (id, account_id, client_id, profile_id, scope, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, 'openid profile', 1000, NULL)`,
      [`ocs_${clientId}_${accountId}`, accountId, clientId, profileId],
    );
  }

  return { app, sqlite, logs, send, register, addProfile, grantConsent };
}

const signOutEverywhereElse = (cookie: string, accessToken: string) =>
  new Request("http://localhost/sessions/revoke-all-other", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Cookie: cookie },
  });

const revokeConnection = (clientId: string, accessToken: string) =>
  new Request(`http://localhost/oidc/connections/${clientId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

const errorLogs = (logs: readonly LogLine[]) => logs.filter((l) => /^error$/i.test(l.level));
const warnLogs = (logs: readonly LogLine[]) => logs.filter((l) => /^warn/i.test(l.level));

describe("POST /sessions/revoke-all-other ends cire organiser sessions", () => {
  it("calls cire once for each profile of the caller's account, and for no other account", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    h.addProfile(ada.accountId, "usr_ada_second", "ada_second");
    const other = await h.register("bob@example.com", "bob");
    const calls = fakeCire();

    const res = await h.send(signOutEverywhereElse(ada.cookie, ada.accessToken));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(calls.map((c) => c.url)).toEqual([
      `${CIRE_URL}/internal/revoke-organiser-sessions`,
      `${CIRE_URL}/internal/revoke-organiser-sessions`,
    ]);
    expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    expect(calls.map((c) => c.body)).toEqual(
      expect.arrayContaining([{ osnProfileId: ada.profileId }, { osnProfileId: "usr_ada_second" }]),
    );
    expect(calls.map((c) => (c.body as { osnProfileId: string }).osnProfileId)).not.toContain(
      other.profileId,
    );
  });

  it("makes no cire call when the OSN revoke fails", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    // A second session, so the revoke's DELETE has a row to touch, and a
    // trigger that refuses deleting it — scoped away from the caller's own
    // row so nothing else this request does can trip it.
    h.sqlite.run(
      `INSERT INTO sessions (id, account_id, family_id, expires_at, created_at)
       VALUES ('other_session_hash', ?, 'sfam_other', ?, ?)`,
      [ada.accountId, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000)],
    );
    const current = hashSessionToken(ada.cookie.slice(ada.cookie.indexOf("=") + 1));
    h.sqlite.run(
      `CREATE TRIGGER refuse_revoke BEFORE DELETE ON sessions WHEN OLD.id != '${current}'
       BEGIN SELECT RAISE(ABORT, 'refused by test'); END;`,
    );
    const calls = fakeCire();

    const res = await h.send(signOutEverywhereElse(ada.cookie, ada.accessToken));

    expect(res.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it("still signs out, and logs an error without the secret, when cire refuses", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    const calls = fakeCire(async () =>
      Response.json({ error: "revocation_unavailable" }, { status: 503 }),
    );

    const res = await h.send(signOutEverywhereElse(ada.cookie, ada.accessToken));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    const errors = errorLogs(h.logs);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.annotations).toMatchObject({ status: 503 });
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it("still signs out, and logs an error, when cire cannot be reached", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    fakeCire(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await h.send(signOutEverywhereElse(ada.cookie, ada.accessToken));

    expect(res.status).toBe(200);
    expect(errorLogs(h.logs)).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it("answers before cire does", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    const { promise: cireAnswers, resolve: releaseCire } = Promise.withResolvers<void>();
    const calls = fakeCire(async () => {
      await cireAnswers;
      return Response.json({ ok: true });
    });
    const handed: Promise<unknown>[] = [];

    // If the route waited for cire, this would never resolve: cire answers
    // only after it does.
    const res = await withBackgroundSink({ waitUntil: (p) => handed.push(p) }, async () =>
      h.app.handle(signOutEverywhereElse(ada.cookie, ada.accessToken)),
    );

    expect(res.status).toBe(200);
    expect(handed).toHaveLength(1);
    releaseCire();
    await Promise.all(handed);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["CIRE_INTERNAL_REVOKE_URL", { url: null, secret: SECRET, clientId: CIRE_CLIENT_ID }],
    ["CIRE_INTERNAL_REVOKE_SECRET", { url: CIRE_URL, secret: null, clientId: CIRE_CLIENT_ID }],
  ] as const)("skips cire with a warning when %s is unset", async (missing, cire) => {
    const h = setup(cire);
    const ada = await h.register("ada@example.com", "ada");
    const calls = fakeCire();

    const res = await h.send(signOutEverywhereElse(ada.cookie, ada.accessToken));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    const warnings = warnLogs(h.logs);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(missing);
    expect(errorLogs(h.logs)).toEqual([]);
  });
});

describe("DELETE /oidc/connections/:clientId ends cire organiser sessions only for cire", () => {
  it("calls cire for each profile of the account when the cire connection is revoked", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    h.addProfile(ada.accountId, "usr_ada_second", "ada_second");
    h.grantConsent(ada.accountId, ada.profileId, CIRE_CLIENT_ID);
    const calls = fakeCire();

    const res = await h.send(revokeConnection(CIRE_CLIENT_ID, ada.accessToken));

    expect(res.status).toBe(200);
    expect(calls.map((c) => c.body)).toEqual(
      expect.arrayContaining([{ osnProfileId: ada.profileId }, { osnProfileId: "usr_ada_second" }]),
    );
    expect(calls).toHaveLength(2);
  });

  it("makes no cire call when another app's connection is revoked", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    h.grantConsent(ada.accountId, ada.profileId, "cid_other_app");
    const calls = fakeCire();

    const res = await h.send(revokeConnection("cid_other_app", ada.accessToken));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("makes no cire call when there is no live cire connection to revoke", async () => {
    const h = setup();
    const ada = await h.register("ada@example.com", "ada");
    const calls = fakeCire();

    const res = await h.send(revokeConnection(CIRE_CLIENT_ID, ada.accessToken));

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
