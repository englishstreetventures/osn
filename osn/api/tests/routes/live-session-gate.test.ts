/**
 * The live-session gate on the routes that mint a step-up token or a fresh
 * recovery-code set.
 *
 * An access token is a self-contained JWT that outlives the session it came
 * from by up to one token lifetime. These routes answer 409 `session_stale` to
 * a token whose session has ended — logged out, rotated away with no cookie to
 * name its successor, restricted to recovery, expired — and still serve a live
 * device. A refusal must spend nothing: no step-up token, no TOTP step, no
 * parked challenge, no code set.
 *
 * Every test names, in its comment, the edit that turns it red.
 */

import { Database } from "bun:sqlite";

import { passkeys, recoveryCodes, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A real WebAuthn ceremony needs an authenticator no route test can drive, so
// only the two verifiers are stubbed: every other step of both ceremonies —
// the parked challenge, the credential lookup, the token mint — runs for real.
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
            id: `lsg-cred-${seq}-${Math.random().toString(16).slice(2, 10)}`,
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
const { deriveSessionBinding, signJwt } = await import("../../src/services/auth/helpers");
const { cookieName } = await import("../../src/lib/cookie-session");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createAuthRoutes } = await import("../helpers/routes");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

let config: AuthConfig;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;
/**
 * The refusal, status and whole body: nothing minted rides along with it.
 * Compared with {@link answerOf}.
 */
const REFUSED = {
  status: 409,
  body: { error: "session_stale", message: "Re-authenticate and try again." },
};

/** Routes and a service over ONE database the test can also read and write. */
function makeApp() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);
  const app = createAuthRoutes(config, layer);
  const auth = createAuthService(config);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  return { app, auth, db, svc };
}

type Harness = ReturnType<typeof makeApp>;
type Profile = Awaited<ReturnType<typeof registerAccount>>;

/** The `Cookie` header a browser holding this session's refresh token sends. */
const cookieFor = (refreshToken: string) => `${cookieName({ secure: false })}=${refreshToken}`;

function post(
  h: Harness,
  path: string,
  opts: { token: string; cookie?: string; body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.token}`,
  };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return h.app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? {}),
    }),
  );
}

async function answerOf(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

function registerAccount(h: Harness, email: string, handle: string) {
  return h.svc(h.auth.registerProfile(email, handle));
}

function openSession(h: Harness, profile: Profile) {
  return h.svc(
    h.auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    ),
  );
}

/** `POST /logout` with the session's cookie, then prove its row is gone. */
async function logOut(h: Harness, refreshToken: string): Promise<void> {
  const res = await h.app.handle(
    new Request("http://localhost/logout", {
      method: "POST",
      headers: { cookie: cookieFor(refreshToken) },
    }),
  );
  expect(res.status).toBe(200);
  const left = await h.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, h.auth.hashSessionToken(refreshToken)));
  expect(left).toHaveLength(0);
}

/**
 * Enrol an authenticator app through the routes, consuming the code at the
 * current step. Returns the code for the next step, which nothing has used.
 */
async function enrolTotp(h: Harness, profile: Profile, accessToken: string): Promise<string> {
  const stepUp = await h.svc(h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));
  const begun = await post(h, "/totp/enroll/begin", {
    token: accessToken,
    body: { step_up_token: stepUp },
  });
  expect(begun.status).toBe(200);
  const { totpSecret } = (await begun.json()) as { totpSecret: string };
  const secret = base32Decode(totpSecret);
  const nowStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const confirmed = await post(h, "/totp/enroll/complete", {
    token: accessToken,
    body: { code: await deriveTotpCode(secret, nowStep) },
  });
  expect(confirmed.status).toBe(200);
  return deriveTotpCode(secret, nowStep + 1);
}

/**
 * Register a passkey through the service and return its credential id. Runs
 * before any session exists: a registration with no caller session revokes
 * every session on the account.
 */
async function enrolPasskey(h: Harness, profile: Profile): Promise<string> {
  await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
  await h.svc(
    h.auth.completePasskeyRegistration(
      profile.accountId,
      {
        id: "x",
        rawId: "x",
        response: {},
        type: "public-key",
        clientExtensionResults: {},
      } as never,
      null,
    ),
  );
  const [row] = await h.db
    .select({ credentialId: passkeys.credentialId })
    .from(passkeys)
    .where(eq(passkeys.accountId, profile.accountId));
  return row!.credentialId;
}

const assertionFor = (credentialId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

const recoveryStepUp = (h: Harness, profile: Profile) =>
  h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "recovery_generate"));

const codeIds = async (h: Harness, profile: Profile) =>
  (
    await h.db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.accountId, profile.accountId))
      .orderBy(asc(recoveryCodes.id))
  ).map((r) => r.id);

describe("a logged-out session's access token", () => {
  it("cannot complete a passkey step-up; a live session's can", async () => {
    // Red on removing the gate from POST /step-up/passkey/complete.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-pk@example.com", "lsgpk");
    const credentialId = await enrolPasskey(h, profile);
    const ended = await openSession(h, profile);
    await logOut(h, ended.refreshToken);

    const begun = await post(h, "/step-up/passkey/begin", { token: ended.accessToken });
    expect(begun.status).toBe(200);
    expect(
      await answerOf(
        await post(h, "/step-up/passkey/complete", {
          token: ended.accessToken,
          body: { assertion: assertionFor(credentialId), purpose: "recovery_generate" },
        }),
      ),
    ).toEqual(REFUSED);

    const live = await openSession(h, profile);
    expect((await post(h, "/step-up/passkey/begin", { token: live.accessToken })).status).toBe(200);
    const minted = await post(h, "/step-up/passkey/complete", {
      token: live.accessToken,
      body: { assertion: assertionFor(credentialId), purpose: "recovery_generate" },
    });
    expect(minted.status).toBe(200);
    expect(((await minted.json()) as { step_up_token: string }).step_up_token).toMatch(/^eyJ/);
  });

  it("cannot complete a TOTP step-up, and the refusal spends no step", async () => {
    // Red on removing the gate from POST /step-up/totp/complete.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-totp@example.com", "lsgtotp");
    const ended = await openSession(h, profile);
    const code = await enrolTotp(h, profile, ended.accessToken);
    await logOut(h, ended.refreshToken);

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", {
          token: ended.accessToken,
          body: { code, purpose: "recovery_generate" },
        }),
      ),
    ).toEqual(REFUSED);

    // The same code still works for a live session, so the refusal recorded
    // no TOTP step against the credential.
    const live = await openSession(h, profile);
    const minted = await post(h, "/step-up/totp/complete", {
      token: live.accessToken,
      body: { code, purpose: "recovery_generate" },
    });
    expect(minted.status).toBe(200);
  });

  it("cannot replace the recovery codes, and the refusal spends no step-up token", async () => {
    // Red on removing the gate from POST /recovery/generate.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-rec@example.com", "lsgrec");
    const ended = await openSession(h, profile);
    const first = await post(h, "/recovery/generate", {
      token: ended.accessToken,
      body: { step_up_token: await recoveryStepUp(h, profile) },
    });
    expect(first.status).toBe(200);
    const original = await codeIds(h, profile);
    expect(original).toHaveLength(10);

    const stepUpToken = await recoveryStepUp(h, profile);
    await logOut(h, ended.refreshToken);

    expect(
      await answerOf(
        await post(h, "/recovery/generate", {
          token: ended.accessToken,
          body: { step_up_token: stepUpToken },
        }),
      ),
    ).toEqual(REFUSED);
    expect(await codeIds(h, profile)).toEqual(original);

    // The same step-up token still works for a live session: the refusal did
    // not spend its single-use id.
    const live = await openSession(h, profile);
    const replaced = await post(h, "/recovery/generate", {
      token: live.accessToken,
      body: { step_up_token: stepUpToken },
    });
    expect(replaced.status).toBe(200);
    expect(await codeIds(h, profile)).not.toEqual(original);
  });
});

describe("what counts as a live session", () => {
  it("a token with no session binding, sent with no cookie, is refused", async () => {
    // Red on letting a caller that presents neither a cookie nor an `osn_sid`
    // through. `/profiles/switch` mints exactly this shape of token when it
    // cannot resolve the caller's session.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-unbound@example.com", "lsgunbound");
    const live = await openSession(h, profile);
    const code = await enrolTotp(h, profile, live.accessToken);

    const unbound = await signJwt(
      {
        sub: profile.id,
        aud: "osn-access",
        email: profile.email,
        handle: profile.handle,
        scope: "openid profile",
      },
      config.jwtPrivateKey,
      config.jwtKid,
      300,
      config.issuerUrl,
    );
    expect(
      await answerOf(await post(h, "/step-up/totp/complete", { token: unbound, body: { code } })),
    ).toEqual(REFUSED);
  });

  it("a live cookie serves a tab whose token predates another tab's renewal", async () => {
    // Red on dropping the session cookie from the gate. Each tab keeps its own
    // access token, and a renewal in one tab deletes the row the other tab's
    // token is bound to; the shared cookie names the live row.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-tabs@example.com", "lsgtabs");
    const tabA = await openSession(h, profile);
    const code = await enrolTotp(h, profile, tabA.accessToken);
    const renewed = await h.svc(h.auth.refreshTokens(tabA.refreshToken));

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", { token: tabA.accessToken, body: { code } }),
      ),
    ).toEqual(REFUSED);
    const served = await post(h, "/step-up/totp/complete", {
      token: tabA.accessToken,
      cookie: cookieFor(renewed.refreshToken),
      body: { code },
    });
    expect(served.status).toBe(200);
  });

  it("a restricted recovery session's cookie does not revive an ended token", async () => {
    // Red on counting restricted rows as live. A restricted session may
    // enrol a passkey and nothing else; it must not reach a step-up mint or a
    // code set through an older token it rides along with.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-restricted@example.com", "lsgrestricted");
    const ended = await openSession(h, profile);
    const code = await enrolTotp(h, profile, ended.accessToken);
    await logOut(h, ended.refreshToken);
    const recovery = await h.svc(
      h.auth.issueRecoverySession(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        "otp",
      ),
    );
    const restrictedCookie = cookieFor(recovery.refreshToken);

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", {
          token: ended.accessToken,
          cookie: restrictedCookie,
          body: { code },
        }),
      ),
    ).toEqual(REFUSED);
    expect(
      await answerOf(
        await post(h, "/recovery/generate", {
          token: ended.accessToken,
          cookie: restrictedCookie,
          body: { step_up_token: await recoveryStepUp(h, profile) },
        }),
      ),
    ).toEqual(REFUSED);

    // Control: an ordinary live cookie on the same account does count.
    const ordinary = await openSession(h, profile);
    const served = await post(h, "/step-up/totp/complete", {
      token: ended.accessToken,
      cookie: cookieFor(ordinary.refreshToken),
      body: { code },
    });
    expect(served.status).toBe(200);
  });

  it("a token bound to a restricted recovery session is refused", async () => {
    // Red on matching the binding against restricted rows. `/profiles/switch`
    // binds the token it mints to whatever session the caller's cookie names,
    // a restricted one included, so this shape reaches the routes.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-rbound@example.com", "lsgrbound");
    const ended = await openSession(h, profile);
    const code = await enrolTotp(h, profile, ended.accessToken);
    await logOut(h, ended.refreshToken);
    const recovery = await h.svc(
      h.auth.issueRecoverySession(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        "otp",
      ),
    );
    const boundToRestricted = await signJwt(
      {
        sub: profile.id,
        aud: "osn-access",
        email: profile.email,
        handle: profile.handle,
        scope: "openid profile",
        osn_sid: deriveSessionBinding(h.auth.hashSessionToken(recovery.refreshToken), profile.id),
      },
      config.jwtPrivateKey,
      config.jwtKid,
      300,
      config.issuerUrl,
    );

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", { token: boundToRestricted, body: { code } }),
      ),
    ).toEqual(REFUSED);
  });

  it("another account's live cookie does not revive an ended token", async () => {
    // Red on reading live sessions across accounts.
    const h = makeApp();
    const owner = await registerAccount(h, "lsg-owner@example.com", "lsgowner");
    const other = await registerAccount(h, "lsg-other@example.com", "lsgother");
    const ended = await openSession(h, owner);
    const code = await enrolTotp(h, owner, ended.accessToken);
    await logOut(h, ended.refreshToken);
    const otherLive = await openSession(h, other);

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", {
          token: ended.accessToken,
          cookie: cookieFor(otherLive.refreshToken),
          body: { code },
        }),
      ),
    ).toEqual(REFUSED);
  });

  it("an expired session row that has not been deleted does not count", async () => {
    // Red on dropping the expiry term from the read. Expiry is otherwise
    // enforced only when the refresh token is redeemed, and nothing deletes
    // the row the moment it lapses.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-expired@example.com", "lsgexpired");
    const s = await openSession(h, profile);
    const code = await enrolTotp(h, profile, s.accessToken);
    await h.db
      .update(sessions)
      .set({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
      .where(eq(sessions.accountId, profile.accountId));

    expect(
      await answerOf(
        await post(h, "/step-up/totp/complete", {
          token: s.accessToken,
          cookie: cookieFor(s.refreshToken),
          body: { code },
        }),
      ),
    ).toEqual(REFUSED);
  });
});
