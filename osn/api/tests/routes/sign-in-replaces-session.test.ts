/**
 * A route that sets a new session cookie ends the device session the request's
 * own cookie named: every session of that cookie's family, live or rotated out.
 *
 * The browser keeps whichever `Set-Cookie` lands last. A `POST /token` grant
 * sent with the old cookie before a sign-in can answer after it, and its answer
 * carries the old family's rotated cookie. Ending that family when the sign-in
 * lands means the late cookie names no session, whatever the grant's timing:
 * the next renewal with it is refused, so the page is signed out rather than
 * acting as whoever held the old cookie.
 *
 * Each session-setting route is checked twice: a sign-in that succeeds ends
 * the incoming cookie's family and keeps the new session, and one that is
 * refused or not yet finished ends nothing. The grant's timings are checked
 * against passkey sign-in with `POST /token` held at each statement it runs.
 */

import { Database } from "bun:sqlite";

import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer, Logger } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

// No unit test can produce a real WebAuthn attestation or assertion, so only
// the two verifiers are stubbed: the challenges are real.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  let seq = 0;
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => {
      seq += 1;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: `sr-cred-${seq}-${Math.random().toString(16).slice(2, 10)}`,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: undefined,
          },
          aaguid: "00000000-0000-0000-0000-000000000000",
          credentialBackedUp: false,
          credentialDeviceType: "singleDevice",
        },
      };
    }),
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })),
  };
});

const { createAuthService } = await import("../../src/services/auth");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createAuthRoutes } = await import("../helpers/routes");
const { holdQueries } = await import("../helpers/held-query");
const { mintStepUpToken } = await import("../helpers/step-up-session");
const { cancelErasure, requestErasure } = await import("../../src/services/account-erasure");
const { makeHeldHandleDigest } = await import("../../src/lib/handle-hold");
const { beginThroughRoutes, confirmThroughRoutes, latestLinkTo, statusThroughRoutes } =
  await import("../helpers/registration");
const { beginRecoveryThroughRoutes, latestRecoveryLinkTo, recoveryStatusThroughRoutes } =
  await import("../helpers/recovery-link");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

let config: AuthConfig;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const DEV_SECRET = "s".repeat(32);
const TOTP_STEP_SECONDS = 30;

type LogLine = { level: string; message: unknown };

/** A route app and a service over one in-memory database whose statements a test can hold. */
function makeHarness() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const held = holdQueries(drizzle({ client: sqlite }));
  const email = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db: held.db }), email.layer);
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
    { secret: DEV_SECRET, allowedReturnOrigins: [] },
  );
  const auth = createAuthService(config);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

  const request = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const withCookie = (token: string | null): Record<string, string> =>
    token === null ? {} : { cookie: `osn_session=${token}` };

  /** `POST /token` with `token` as the session cookie. */
  const grant = (token: string) =>
    request("/token", { grant_type: "refresh_token" }, withCookie(token));

  /** An account with one ordinary session; its refresh token and family. */
  const signedIn = async (handle: string) => {
    const profile = await svc(auth.registerProfile(`${handle}@example.com`, handle));
    const token = await openSession(profile);
    return { profile, token, familyId: familyOf(token) };
  };
  const openSession = async (profile: {
    id: string;
    accountId: string;
    email: string;
    handle: string;
    displayName: string | null;
  }) =>
    (
      await svc(
        auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        ),
      )
    ).refreshToken;

  const familyOf = (token: string) =>
    (
      sqlite
        .query("SELECT family_id AS familyId FROM sessions WHERE id = ?")
        .get(auth.hashSessionToken(token)) as { familyId: string } | null
    )?.familyId;
  const familyRows = (familyId: string) =>
    (
      sqlite.query("SELECT COUNT(*) AS n FROM sessions WHERE family_id = ?").get(familyId) as {
        n: number;
      }
    ).n;

  return {
    app,
    auth,
    sqlite,
    held,
    logs,
    recorded: email.recorded,
    svc,
    request,
    withCookie,
    grant,
    signedIn,
    openSession,
    familyOf,
    familyRows,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** The session token a response's `Set-Cookie` carries, or null. */
function sessionCookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    const match = /^osn_session=([^;]+)/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) => ({
  id: credentialId,
  rawId: credentialId,
  response: {},
  type: "public-key",
  clientExtensionResults: {},
});

/** An account with one passkey; its email and credential id. */
async function withPasskey(h: Harness, handle: string) {
  const profile = await h.svc(h.auth.registerProfile(`${handle}@example.com`, handle));
  await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
  await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
  const [row] = await h.sqlite
    .query("SELECT credential_id AS credentialId FROM passkeys WHERE account_id = ?")
    .all(profile.accountId);
  return {
    profile,
    identifier: profile.email,
    credentialId: (row as { credentialId: string }).credentialId,
  };
}

/** `/login/passkey/begin` then `/login/passkey/complete`, the second with `cookie`. */
async function passkeySignIn(
  h: Harness,
  account: { identifier: string; credentialId: string },
  cookie: string | null,
) {
  const begun = await h.request("/login/passkey/begin", { identifier: account.identifier });
  expect(begun.status).toBe(200);
  return h.request(
    "/login/passkey/complete",
    { identifier: account.identifier, assertion: fakeAssertion(account.credentialId) },
    h.withCookie(cookie),
  );
}

/** An account with a confirmed authenticator; its email and secret. */
async function withTotp(h: Harness, handle: string) {
  const profile = await h.svc(h.auth.registerProfile(`${handle}@example.com`, handle));
  const tokens = await h.svc(
    h.auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    ),
  );
  const authorization = `Bearer ${tokens.accessToken}`;
  const stepUp = await h.svc(mintStepUpToken(h.auth, profile.accountId, "passkey", "totp_enroll"));
  const begun = await h.request("/totp/enroll/begin", { step_up_token: stepUp }, { authorization });
  const secret = base32Decode(((await begun.json()) as { totpSecret: string }).totpSecret);
  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const confirmed = await h.request(
    "/totp/enroll/complete",
    { code: await deriveTotpCode(secret, step) },
    { authorization },
  );
  expect(confirmed.status).toBe(200);
  return { identifier: profile.email, secret, step };
}

/**
 * One route that sets a new session cookie: how to reach it successfully and
 * unsuccessfully, each time with `cookie` on the request that would set it.
 * Every account here is another account than the cookie's.
 */
interface SessionRoute {
  readonly name: string;
  readonly okStatus: number;
  readonly refusedStatus: number;
  readonly signIn: (h: Harness, cookie: string) => Promise<Response>;
  readonly refused: (h: Harness, cookie: string) => Promise<Response>;
}

const ROUTES: readonly SessionRoute[] = [
  {
    name: "POST /login/passkey/complete",
    okStatus: 200,
    refusedStatus: 400,
    signIn: async (h, cookie) => passkeySignIn(h, await withPasskey(h, "pk_ok"), cookie),
    // No ceremony was begun, so no challenge waits for this assertion.
    refused: async (h, cookie) => {
      const account = await withPasskey(h, "pk_no");
      return h.request(
        "/login/passkey/complete",
        { identifier: account.identifier, assertion: fakeAssertion(account.credentialId) },
        h.withCookie(cookie),
      );
    },
  },
  {
    name: "POST /login/recovery/complete",
    okStatus: 200,
    refusedStatus: 400,
    signIn: async (h, cookie) => {
      const profile = await h.svc(h.auth.registerProfile("rc-ok@example.com", "rc_ok"));
      const { recoveryCodes } = await h.svc(
        h.auth.generateRecoveryCodesForAccount(profile.accountId),
      );
      return h.request(
        "/login/recovery/complete",
        { identifier: profile.email, code: recoveryCodes[0] },
        h.withCookie(cookie),
      );
    },
    refused: async (h, cookie) => {
      const profile = await h.svc(h.auth.registerProfile("rc-no@example.com", "rc_no"));
      await h.svc(h.auth.generateRecoveryCodesForAccount(profile.accountId));
      return h.request(
        "/login/recovery/complete",
        { identifier: profile.email, code: "0000-0000-0000-0000" },
        h.withCookie(cookie),
      );
    },
  },
  {
    name: "POST /register/:requestId/status",
    okStatus: 201,
    // Not yet confirmed: the poll answers `pending` and sets no cookie.
    refusedStatus: 200,
    signIn: async (h, cookie) => {
      const { body } = await beginThroughRoutes(h.app, {
        email: "su-ok@example.com",
        handle: "su_ok",
      });
      const link = latestLinkTo(h.recorded(), "su-ok@example.com")!;
      const confirmed = await confirmThroughRoutes(
        h.app,
        link.requestId,
        link.linkSecret,
        body.pairingCode,
      );
      expect(confirmed.status).toBe(200);
      return statusThroughRoutes(h.app, body.requestId, body.claimSecret, h.withCookie(cookie));
    },
    refused: async (h, cookie) => {
      const { body } = await beginThroughRoutes(h.app, {
        email: "su-no@example.com",
        handle: "su_no",
      });
      return statusThroughRoutes(h.app, body.requestId, body.claimSecret, h.withCookie(cookie));
    },
  },
  {
    name: "POST /login/recovery/email/:requestId/status",
    okStatus: 201,
    // Not yet confirmed: the poll answers `pending` and sets no cookie.
    refusedStatus: 200,
    signIn: async (h, cookie) => {
      await h.svc(h.auth.registerProfile("er-ok@example.com", "er_ok"));
      const { body } = await beginRecoveryThroughRoutes(h.app, "er-ok@example.com");
      const link = latestRecoveryLinkTo(h.recorded(), "er-ok@example.com")!;
      const confirmed = await h.request(`/email-link/${link.requestId}/confirm`, {
        linkSecret: link.linkSecret,
        pairingPick: body.pairingCode,
      });
      expect(confirmed.status).toBe(200);
      return recoveryStatusThroughRoutes(
        h.app,
        body.requestId,
        body.claimSecret,
        h.withCookie(cookie),
      );
    },
    refused: async (h, cookie) => {
      await h.svc(h.auth.registerProfile("er-no@example.com", "er_no"));
      const { body } = await beginRecoveryThroughRoutes(h.app, "er-no@example.com");
      return recoveryStatusThroughRoutes(
        h.app,
        body.requestId,
        body.claimSecret,
        h.withCookie(cookie),
      );
    },
  },
  {
    name: "POST /login/recovery/totp/complete",
    okStatus: 200,
    refusedStatus: 400,
    signIn: async (h, cookie) => {
      const { identifier, secret, step } = await withTotp(h, "rt_ok");
      // The enrolment spent the current step's code.
      const code = await deriveTotpCode(secret, step + 1);
      return h.request("/login/recovery/totp/complete", { identifier, code }, h.withCookie(cookie));
    },
    refused: async (h, cookie) => {
      const { identifier, secret, step } = await withTotp(h, "rt_no");
      const code = await deriveTotpCode(secret, step + 1000);
      return h.request("/login/recovery/totp/complete", { identifier, code }, h.withCookie(cookie));
    },
  },
  {
    name: "POST /login/cross-device/:requestId/status",
    okStatus: 200,
    // Not yet approved: the poll answers `pending` and sets no cookie.
    refusedStatus: 200,
    signIn: async (h, cookie) => {
      const approver = await h.svc(h.auth.registerProfile("cd-ok@example.com", "cd_ok"));
      const tokens = await h.svc(
        h.auth.issueTokens(
          approver.id,
          approver.accountId,
          approver.email,
          approver.handle,
          approver.displayName,
        ),
      );
      const begun = await h.request("/login/cross-device/begin", {});
      const { requestId, cdlSecret } = (await begun.json()) as {
        requestId: string;
        cdlSecret: string;
      };
      const approved = await h.request(
        `/login/cross-device/${requestId}/approve`,
        { secret: cdlSecret },
        { authorization: `Bearer ${tokens.accessToken}` },
      );
      expect(approved.status).toBe(200);
      return h.request(
        `/login/cross-device/${requestId}/status`,
        { secret: cdlSecret },
        h.withCookie(cookie),
      );
    },
    refused: async (h, cookie) => {
      const begun = await h.request("/login/cross-device/begin", {});
      const { requestId, cdlSecret } = (await begun.json()) as {
        requestId: string;
        cdlSecret: string;
      };
      return h.request(
        `/login/cross-device/${requestId}/status`,
        { secret: cdlSecret },
        h.withCookie(cookie),
      );
    },
  },
  {
    name: "POST /dev/login/form",
    okStatus: 200,
    refusedStatus: 401,
    signIn: (h, cookie) => devForm(h, DEV_SECRET, cookie),
    refused: (h, cookie) => devForm(h, "x".repeat(32), cookie),
  },
  {
    name: "POST /dev/login",
    okStatus: 200,
    refusedStatus: 401,
    signIn: (h, cookie) => h.request("/dev/login", { secret: DEV_SECRET }, h.withCookie(cookie)),
    refused: (h, cookie) =>
      h.request("/dev/login", { secret: "x".repeat(32) }, h.withCookie(cookie)),
  },
];

/** The form post the dev sign-in page sends. */
function devForm(h: Harness, secret: string, cookie: string) {
  return h.app.handle(
    new Request("http://localhost/dev/login/form", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `osn_session=${cookie}`,
      },
      body: new URLSearchParams({ secret }).toString(),
    }),
  );
}

describe("a route that sets a new session cookie", () => {
  for (const route of ROUTES) {
    it(`${route.name} ends the family of the session its cookie named, and keeps the new one`, async () => {
      const h = makeHarness();
      const old = await h.signedIn("old_owner");

      const res = await route.signIn(h, old.token);

      expect(res.status).toBe(route.okStatus);
      const fresh = sessionCookieOf(res);
      expect(fresh).not.toBeNull();
      expect(h.familyRows(old.familyId!)).toBe(0);
      expect((await h.grant(old.token)).status).toBe(400);
      expect((await h.grant(fresh!)).status).toBe(200);
    });

    it(`${route.name} ends nothing when it sets no cookie`, async () => {
      const h = makeHarness();
      const old = await h.signedIn("old_owner");

      const res = await route.refused(h, old.token);

      expect(res.status).toBe(route.refusedStatus);
      expect(sessionCookieOf(res)).toBeNull();
      expect((await h.grant(old.token)).status).toBe(200);
    });
  }
});

describe("a passkey sign-in and the session the request carried", () => {
  it("ends nothing when the request carries no cookie", async () => {
    const h = makeHarness();
    const account = await withPasskey(h, "nocookie");
    const one = await h.openSession(account.profile);
    const two = await h.openSession(account.profile);

    const res = await passkeySignIn(h, account, null);

    expect(res.status).toBe(200);
    expect((await h.grant(one)).status).toBe(200);
    expect((await h.grant(two)).status).toBe(200);
  });

  it("signs in quietly with a cookie that names no session", async () => {
    // The commonest cookie a browser brings to a sign-in: one logged out, or
    // long expired. Ending its family finds nothing and is no failure.
    const h = makeHarness();
    const old = await h.signedIn("old_owner");
    expect((await h.request("/logout", {}, h.withCookie(old.token))).status).toBe(200);
    const account = await withPasskey(h, "stalecookie");

    const res = await passkeySignIn(h, account, old.token);

    expect(res.status).toBe(200);
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
    expect(h.logs.filter((line) => line.level === "ERROR")).toEqual([]);
  });

  it("signing in again as the same account ends only the device the cookie named", async () => {
    const h = makeHarness();
    const account = await withPasskey(h, "sameacct");
    const here = await h.openSession(account.profile);
    const elsewhere = await h.openSession(account.profile);

    const res = await passkeySignIn(h, account, here);

    expect(res.status).toBe(200);
    expect((await h.grant(here)).status).toBe(400);
    expect((await h.grant(elsewhere)).status).toBe(200);
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
  });

  it("still answers with its cookie when ending the old session fails, and logs it naming no one", async () => {
    const h = makeHarness();
    const old = await h.signedIn("old_owner");
    const account = await withPasskey(h, "revokefail");
    h.sqlite.run(
      `CREATE TRIGGER refuse_old_family BEFORE DELETE ON sessions
         WHEN OLD.family_id = '${old.familyId}'
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );

    const res = await passkeySignIn(h, account, old.token);

    expect(res.status).toBe(200);
    const fresh = sessionCookieOf(res);
    expect(fresh).not.toBeNull();
    expect((await h.grant(fresh!)).status).toBe(200);
    const errors = h.logs.filter((line) => line.level === "ERROR");
    expect(errors.map((line) => String(line.message))).toEqual([
      "Sign-in could not end the session its cookie named",
    ]);
    const written = JSON.stringify(h.logs);
    for (const secret of [
      old.token,
      h.auth.hashSessionToken(old.token),
      old.familyId!,
      old.profile.accountId,
    ]) {
      expect(written).not.toContain(secret);
    }
  });
});

describe("a sign-in on a browser holding a session of an account scheduled for deletion", () => {
  /**
   * Account A asks to be deleted from the session `token`, which the deletion
   * keeps as its cancel handle. The account can also sign in again from any
   * device while the deletion is pending, so a sign-in ends this session as it
   * ends any other.
   */
  async function scheduledForDeletion(h: Harness) {
    const old = await h.signedIn("leaving");
    await h.svc(
      requestErasure({
        accountId: old.profile.accountId,
        cancel: { sessionId: h.auth.hashSessionToken(old.token), familyId: old.familyId! },
        heldHandleDigest: makeHeldHandleDigest(undefined),
      }),
    );
    return old;
  }

  /** `POST /token` with `token` as the cookie, naming `profileId`. */
  const grantFor = (h: Harness, token: string, profileId: string) =>
    h.request(
      "/token",
      { grant_type: "refresh_token", profile_id: profileId },
      h.withCookie(token),
    );

  it("ends the old family when the account signs in again over its own session", async () => {
    // Red on sparing every family of an account scheduled for deletion: a
    // copy of the old refresh token would stay live beside the new session.
    const h = makeHarness();
    const account = await withPasskey(h, "comeback");
    const token = await h.openSession(account.profile);
    const familyId = h.familyOf(token)!;
    await h.svc(
      requestErasure({
        accountId: account.profile.accountId,
        cancel: { sessionId: h.auth.hashSessionToken(token), familyId },
        heldHandleDigest: makeHeldHandleDigest(undefined),
      }),
    );

    const res = await passkeySignIn(h, account, token);

    expect(res.status).toBe(200);
    expect(h.familyRows(familyId)).toBe(0);
    expect((await grantFor(h, token, account.profile.id)).status).toBe(400);
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
  });

  it("ends the deletion's session as it ends any other", async () => {
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);

    const res = await passkeySignIn(h, await withPasskey(h, "newcomer"), leaving.token);

    expect(res.status).toBe(200);
    expect(h.familyRows(leaving.familyId!)).toBe(0);
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(400);
  });

  it("ends the handle as reuse when the cookie was rotated out past the grace window", async () => {
    // A token the handle's own renewals moved on from long ago is a replay,
    // whatever request carries it: reuse detection ends the family here as
    // `/token` would.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    const renewed = await grantFor(h, leaving.token, leaving.profile.id);
    expect(renewed.status).toBe(200);
    h.sqlite
      .query("UPDATE rotated_sessions SET rotated_at = ? WHERE account_id = ?")
      .run(Date.now() - 60_000, leaving.profile.accountId);

    const res = await passkeySignIn(h, await withPasskey(h, "newcomer"), leaving.token);

    expect(res.status).toBe(200);
    expect(h.familyRows(leaving.familyId!)).toBe(0);
    expect((await grantFor(h, sessionCookieOf(renewed)!, leaving.profile.id)).status).toBe(400);
  });

  it("leaves the ended session nothing to renew, and OpenID Connect sees no session", async () => {
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    expect((await passkeySignIn(h, await withPasskey(h, "newcomer"), leaving.token)).status).toBe(
      200,
    );

    expect((await h.grant(leaving.token)).status).toBe(400);
    const authorize = await h.svc(Effect.result(h.auth.verifyRefreshToken(leaving.token)));
    expect(authorize._tag).toBe("Failure");
  });

  it("keeps a session marked replaced renewing only as its own account, the deletion cancelled or not", async () => {
    // No path marks a session now; a row that carries the mark keeps its rule
    // until it expires.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    const newcomer = await withPasskey(h, "newcomer");
    h.sqlite
      .query("UPDATE sessions SET replaced_at = ? WHERE family_id = ?")
      .run(Math.floor(Date.now() / 1000), leaving.familyId!);

    expect((await h.grant(leaving.token)).status).toBe(400);
    const authorize = await h.svc(Effect.result(h.auth.verifyRefreshToken(leaving.token)));
    expect(authorize._tag).toBe("Failure");
    const own = await grantFor(h, leaving.token, leaving.profile.id);
    expect(own.status).toBe(200);
    expect(await h.svc(cancelErasure(leaving.profile.accountId))).toEqual({ cancelled: true });

    const rotated = sessionCookieOf(own)!;
    expect((await grantFor(h, rotated, newcomer.profile.id)).status).toBe(400);
    expect((await h.grant(rotated)).status).toBe(400);
    expect((await grantFor(h, rotated, leaving.profile.id)).status).toBe(200);
  });

  it("refuses a handle no sign-in marked a renewal for a profile its account does not own", async () => {
    // A row written before the mark existed, or one no sign-in has replaced
    // yet, is still refused another account's profile.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    const newcomer = await withPasskey(h, "newcomer");

    expect((await grantFor(h, leaving.token, newcomer.profile.id)).status).toBe(400);
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(200);
  });

  it("ends the renewed session when the sign-in carries the cookie it just rotated", async () => {
    // The session renewed a moment before the sign-in, which still carries the
    // old cookie: the end reaches the family through the rotation record.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    const newcomer = await withPasskey(h, "newcomer");
    const renewed = await grantFor(h, leaving.token, leaving.profile.id);
    expect(renewed.status).toBe(200);
    const late = sessionCookieOf(renewed)!;

    expect((await passkeySignIn(h, newcomer, leaving.token)).status).toBe(200);

    expect(h.familyRows(leaving.familyId!)).toBe(0);
    expect((await grantFor(h, late, leaving.profile.id)).status).toBe(400);
  });

  it("leaves a handle no sign-in replaced to renew naming no profile", async () => {
    // The account's own cold start, on its own browser: the refusals above
    // follow the sign-in, not the deletion.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);

    expect((await h.grant(leaving.token)).status).toBe(200);
  });

  it("refuses the handle's cookie a renewal for the profile the new sign-in holds", async () => {
    // The handle's cookie can land after the sign-in's (a renewal of it was
    // in flight); the page that signed in then renews with it, naming its own
    // profile. The grant is refused, so the page is signed out rather than
    // acting as the account scheduled for deletion.
    const h = makeHarness();
    const leaving = await scheduledForDeletion(h);
    const newcomer = await withPasskey(h, "newcomer");
    const res = await passkeySignIn(h, newcomer, leaving.token);
    expect(res.status).toBe(200);

    const swapped = await grantFor(h, leaving.token, newcomer.profile.id);

    expect(swapped.status).toBe(400);
    expect(sessionCookieOf(swapped)).toBeNull();
    // The sign-in ended it: it renews for no profile, its own included.
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(400);
  });
});

describe("a renewal racing a sign-in sent with the same cookie", () => {
  it("a renewal that rotated the cookie before the sign-in leaves a cookie the next renewal refuses", async () => {
    const h = makeHarness();
    const old = await h.signedIn("old_owner");
    const rotated = await h.grant(old.token);
    expect(rotated.status).toBe(200);
    const late = sessionCookieOf(rotated)!;

    const res = await passkeySignIn(h, await withPasskey(h, "newcomer"), old.token);

    expect(res.status).toBe(200);
    expect((await h.grant(late)).status).toBe(400);
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
  });

  /** The statements of a rotation, in the order `refreshTokens` runs them. */
  const ROTATION_STEPS: ReadonlyArray<{ readonly step: string; readonly pattern: RegExp }> = [
    { step: "insert of the new session", pattern: /^insert into "sessions"/ },
    { step: "rotation record", pattern: /^insert into "rotated_sessions"/ },
    { step: "swap", pattern: /^delete from "sessions"/ },
  ];

  for (const { step, pattern } of ROTATION_STEPS) {
    it(`a renewal held at its ${step} while the sign-in lands sets no cookie and leaves no session`, async () => {
      const h = makeHarness();
      const old = await h.signedIn("old_owner");
      const account = await withPasskey(h, "newcomer");

      const rotation = h.held.hold(pattern);
      const renewal = h.grant(old.token);
      await rotation.reached;
      const res = await passkeySignIn(h, account, old.token);
      rotation.release();
      const answer = await renewal;

      expect(res.status).toBe(200);
      expect(answer.status).toBe(400);
      expect(sessionCookieOf(answer)).toBeNull();
      expect(h.familyRows(old.familyId!)).toBe(0);
      expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
    });
  }

  it("a renewal that reads the cookie after the sign-in landed is refused, clears the marker, and leaves the new cookie", async () => {
    const h = makeHarness();
    const old = await h.signedIn("old_owner");
    const account = await withPasskey(h, "newcomer");

    const read = h.held.hold(/^select .+ from "sessions" where "sessions"\."id" = \?/);
    const renewal = h.grant(old.token);
    await read.reached;
    const res = await passkeySignIn(h, account, old.token);
    read.release();
    const answer = await renewal;

    expect(res.status).toBe(200);
    expect(answer.status).toBe(400);
    expect(sessionCookieOf(answer)).toBeNull();
    // The refusal proves the old cookie dead, so the answer retracts the
    // marker, landing after the sign-in's. The next renewal of the new
    // cookie sets it again.
    expect(answer.headers.getSetCookie().some((line) => line.startsWith("osn_has_session=;"))).toBe(
      true,
    );
    expect((await h.grant(sessionCookieOf(res)!)).status).toBe(200);
  });
});

describe("a sign-in over the cancel handle of a deletion scheduled before restore records existed", () => {
  /**
   * A job with no restore record: the soft delete that wrote it also deleted
   * the account's passkeys, recovery codes and TOTP, so the session it kept is
   * that account's only way to cancel. Simulated by clearing the record.
   */
  async function scheduledBeforeRestoreRecords(h: Harness) {
    const old = await h.signedIn("legacy");
    await h.svc(
      requestErasure({
        accountId: old.profile.accountId,
        cancel: { sessionId: h.auth.hashSessionToken(old.token), familyId: old.familyId! },
        heldHandleDigest: makeHeldHandleDigest(undefined),
      }),
    );
    h.sqlite
      .query("UPDATE deletion_jobs SET restore = NULL WHERE account_id = ?")
      .run(old.profile.accountId);
    return old;
  }

  const grantFor = (h: Harness, token: string, profileId: string) =>
    h.request(
      "/token",
      { grant_type: "refresh_token", profile_id: profileId },
      h.withCookie(token),
    );

  const markedRows = (h: Harness, familyId: string) =>
    (
      h.sqlite
        .query("SELECT count(*) AS n FROM sessions WHERE family_id = ? AND replaced_at IS NOT NULL")
        .get(familyId) as { n: number }
    ).n;

  it("keeps the handle live, marks it replaced, and it can still cancel", async () => {
    // Red on ending every family at sign-in: this account has no credential
    // left to sign in with, so it would lose its only way to cancel.
    const h = makeHarness();
    const leaving = await scheduledBeforeRestoreRecords(h);

    const res = await passkeySignIn(h, await withPasskey(h, "newcomer"), leaving.token);

    expect(res.status).toBe(200);
    expect(h.familyRows(leaving.familyId!)).toBe(1);
    expect(markedRows(h, leaving.familyId!)).toBe(1);
    expect((await h.grant(leaving.token)).status).toBe(400);
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(200);
    expect(await h.svc(cancelErasure(leaving.profile.accountId))).toEqual({ cancelled: true });
  });

  it("fails a renewal the mark would refuse when the mark lands while it rotates", async () => {
    const h = makeHarness();
    const leaving = await scheduledBeforeRestoreRecords(h);
    const newcomer = await withPasskey(h, "newcomer");

    const mint = h.held.hold(/^insert into "sessions"/);
    const renewal = h.grant(leaving.token);
    await mint.reached;
    expect((await passkeySignIn(h, newcomer, leaving.token)).status).toBe(200);
    mint.release();
    const answer = await renewal;

    expect(answer.status).toBe(400);
    expect(sessionCookieOf(answer)).toBeNull();
    // The handle is untouched: still live, marked, and renewing as itself.
    expect((await h.grant(leaving.token)).status).toBe(400);
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(200);
  });

  it("fails the handle's own renewal as a rotation race when the mark lands while it rotates", async () => {
    // The guard cannot tell the account's own profile from another's while
    // the account is scheduled for deletion, so its own renewal loses the
    // race too; the retry, naming its own profile, renews.
    const h = makeHarness();
    const leaving = await scheduledBeforeRestoreRecords(h);
    const newcomer = await withPasskey(h, "newcomer");

    const mint = h.held.hold(/^insert into "sessions"/);
    const renewal = grantFor(h, leaving.token, leaving.profile.id);
    await mint.reached;
    expect((await passkeySignIn(h, newcomer, leaving.token)).status).toBe(200);
    mint.release();

    expect((await renewal).status).toBe(400);
    expect((await grantFor(h, leaving.token, leaving.profile.id)).status).toBe(200);
  });

  it("marks the handle's renewed session when the sign-in carries the cookie it just rotated", async () => {
    // The handle renewed a moment before the sign-in, which still carries the
    // old cookie: the mark reaches the family through the rotation record.
    const h = makeHarness();
    const leaving = await scheduledBeforeRestoreRecords(h);
    const newcomer = await withPasskey(h, "newcomer");
    const renewed = await grantFor(h, leaving.token, leaving.profile.id);
    expect(renewed.status).toBe(200);
    const late = sessionCookieOf(renewed)!;

    expect((await passkeySignIn(h, newcomer, leaving.token)).status).toBe(200);

    expect(h.familyRows(leaving.familyId!)).toBe(1);
    expect((await grantFor(h, late, newcomer.profile.id)).status).toBe(400);
    expect((await h.grant(late)).status).toBe(400);
  });
});
