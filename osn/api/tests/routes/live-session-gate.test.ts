/**
 * The live-session gate on the routes that mint a step-up token, an access
 * token, a session or a credential, or that spend what the owner's own
 * step-up or email change depends on.
 *
 * An access token is a self-contained JWT that outlives the session it came
 * from by up to one token lifetime. These routes answer 409 `session_stale` to
 * a token whose session has ended — logged out, rotated away with no cookie to
 * name its successor, restricted to recovery, expired — and still serve a live
 * device. A refusal must spend nothing: no step-up token, no TOTP step, no
 * parked challenge, no code set, no mail, no slot of a per-account cap, no
 * emailed-link request, no pending change, no session.
 *
 * Every test names, in its comment, the edit that turns it red.
 */

import { Database } from "bun:sqlite";

import {
  accounts,
  oauthClients,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveSessionGateEndpoint } from "../../src/metrics";
import { settledHandle } from "../helpers/background";
import { confirmLinkThroughRoutes, linkForRequest } from "../helpers/step-up-link";

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

/**
 * The endpoint name of every `session_stale` refusal, in order. The spy calls
 * through, so the counter itself is unchanged.
 */
const staleRefusals = vi.hoisted(() => [] as string[]);
vi.mock("../../src/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/metrics")>();
  return {
    ...actual,
    metricSessionStaleRefused: (
      endpoint: Parameters<typeof actual.metricSessionStaleRefused>[0],
    ) => {
      staleRefusals.push(endpoint);
      actual.metricSessionStaleRefused(endpoint);
    },
  };
});

const { verifyAuthenticationResponse, verifyRegistrationResponse } =
  await import("@simplewebauthn/server");
const { createAuthService } = await import("../../src/services/auth");
const { deriveSessionBinding, sessionHandleFromHash, signJwt } =
  await import("../../src/services/auth/helpers");
const { createAccountErasureRoutes } = await import("../../src/routes/account-erasure");
const { createAccountExportRoutes } = await import("../../src/routes/account-export");
const { createDefaultCeremonyStores, createInMemoryAccountCap } =
  await import("../../src/services/auth/stores");
const { cookieName } = await import("../../src/lib/cookie-session");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createAuthRoutes } = await import("../helpers/routes");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A per-account cap that admits `n` calls a day: a refusal that spent a slot shows. */
const capOf = (n: number) => createInMemoryAccountCap(n, DAY_MS);

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

/**
 * Routes and a service over ONE database, ONE set of ceremony stores and the
 * same per-account caps, which the test can also read. `overrides` replaces
 * caps with tight ones, so a refusal that spent a slot leaves the next live
 * call refused.
 */
function makeApp(overrides: Partial<AuthConfig> = {}) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);
  const merged = { ...config, ceremonyStores: createDefaultCeremonyStores(), ...overrides };
  const app = createAuthRoutes(merged, layer);
  const cookieConfig = { secure: false };
  const proxied = { trustedProxyCount: 1 };
  const erasure = createAccountErasureRoutes(
    merged,
    layer,
    undefined,
    undefined,
    cookieConfig,
    proxied,
  );
  const exporter = createAccountExportRoutes(
    merged,
    cookieConfig,
    layer,
    undefined,
    undefined,
    undefined,
    proxied,
    undefined,
    [],
  );
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  /** The route module that serves `path`. */
  const appFor = (path: string) =>
    path === "/account/export"
      ? exporter
      : path === "/account" || path === "/account/restore"
        ? erasure
        : app;
  return { app, appFor, auth, db, svc, recorded: () => recorder.recorded() };
}

type Harness = ReturnType<typeof makeApp>;
type Profile = Awaited<ReturnType<typeof registerAccount>>;

/** The `Cookie` header a browser holding this session's refresh token sends. */
const cookieFor = (refreshToken: string) => `${cookieName({ secure: false })}=${refreshToken}`;

/**
 * POSTs to the routes and waits for the work the request started after its
 * answer, mail included, so "nothing was sent" is a fact by the time a test
 * reads it.
 */
function send(
  h: Harness,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    ...opts.headers,
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return settledHandle(
    h.appFor(path),
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
    }),
  );
}

const post = (
  h: Harness,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown },
): Promise<Response> => send(h, "POST", path, opts);

/** Mail sent to `to` so far. */
const mailTo = (h: Harness, to: string) => h.recorded().filter((m) => m.to === to).length;

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
  // A step-up token, which a registration past the first needs.
  const stepUp = await h.svc(
    h.auth.issueStepUpToken(profile.accountId, "passkey", "passkey_register"),
  );
  await h.svc(h.auth.beginPasskeyRegistration(profile.accountId, stepUp));
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
  it("cannot complete a passkey step-up, and the refusal leaves the challenge", async () => {
    // Red on removing the gate from POST /step-up/passkey/complete, or on
    // moving it after the ceremony takes the account's parked challenge.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-pk@example.com", "lsgpk");
    const credentialId = await enrolPasskey(h, profile);
    const ended = await openSession(h, profile);
    const live = await openSession(h, profile);
    await logOut(h, ended.refreshToken);

    const begun = await post(h, "/step-up/passkey/begin", { token: live.accessToken });
    expect(begun.status).toBe(200);
    expect(
      await answerOf(
        await post(h, "/step-up/passkey/complete", {
          token: ended.accessToken,
          body: { assertion: assertionFor(credentialId), purpose: "recovery_generate" },
        }),
      ),
    ).toEqual(REFUSED);

    // No second `begin`: the challenge is parked per account, so the live
    // session completes against the one the refused call left in place.
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
    // through: such a caller names no session the gate could find live.
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
    // Red on matching the binding against restricted rows: an `osn-access`
    // token whose `osn_sid` names a restricted recovery session is refused.
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

// ---------------------------------------------------------------------------
// The routes that begin, resend or finish a step-up or an email change, switch
// profile, approve another device or confirm an authenticator app.
// ---------------------------------------------------------------------------

/** Two sessions of one account: `ended` has been logged out, `live` has not. */
async function endedAndLive(h: Harness, email: string, handle: string) {
  const profile = await registerAccount(h, email, handle);
  const ended = await openSession(h, profile);
  const live = await openSession(h, profile);
  await logOut(h, ended.refreshToken);
  return { profile, ended, live };
}

/** What a step-up or email-change begin answers the tab that began. */
interface Begun {
  readonly requestId: string;
  readonly claimSecret: string;
  readonly pairingCode: string;
}

async function beginStepUpEmail(h: Harness, token: string): Promise<Begun> {
  const res = await post(h, "/step-up/email/begin", {
    token,
    body: { purpose: "account_export" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Begun;
}

async function beginEmailChange(h: Harness, token: string, newEmail: string): Promise<Begun> {
  const res = await post(h, "/account/email/begin", { token, body: { new_email: newEmail } });
  expect(res.status).toBe(200);
  return (await res.json()) as Begun;
}

/** Confirms the request's mailed link with the number its tab shows. */
async function confirmLink(h: Harness, begun: Begun): Promise<void> {
  const link = linkForRequest(h.recorded(), begun.requestId);
  expect(link).not.toBeNull();
  const res = await confirmLinkThroughRoutes(
    h.app,
    begun.requestId,
    link!.linkSecret,
    begun.pairingCode,
  );
  expect(res.status).toBe(200);
}

const emailOf = async (h: Harness, profile: Profile) =>
  (
    await h.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId))
  )[0]?.email;

const sessionIds = async (h: Harness, profile: Profile) =>
  (
    await h.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.accountId, profile.accountId))
  ).map((r) => r.id);

const recoverySessionFor = (h: Harness, profile: Profile) =>
  h.svc(
    h.auth.issueRecoverySession(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
      "otp",
    ),
  );

describe("a logged-out session's access token, at step-up's other routes", () => {
  it("cannot begin a passkey step-up, and the refusal leaves the live session's challenge", async () => {
    // Red on removing the gate from POST /step-up/passkey/begin: the refused
    // begin parks its own challenge over the live session's, so the live
    // completion verifies against a challenge it never saw.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-pkb@example.com", "lsgpkb");
    const credentialId = await enrolPasskey(h, profile);
    const ended = await openSession(h, profile);
    const live = await openSession(h, profile);
    await logOut(h, ended.refreshToken);

    const begun = await post(h, "/step-up/passkey/begin", { token: live.accessToken });
    expect(begun.status).toBe(200);
    const { options } = (await begun.json()) as { options: { challenge: string } };

    expect(
      await answerOf(await post(h, "/step-up/passkey/begin", { token: ended.accessToken })),
    ).toEqual(REFUSED);

    const verify = vi.mocked(verifyAuthenticationResponse);
    verify.mockClear();
    const minted = await post(h, "/step-up/passkey/complete", {
      token: live.accessToken,
      body: { assertion: assertionFor(credentialId), purpose: "recovery_generate" },
    });
    expect(minted.status).toBe(200);
    expect(verify.mock.calls.at(-1)?.[0].expectedChallenge).toBe(options.challenge);
  });

  it("cannot begin a step-up by email: no mail, and the daily link ceiling is not spent", async () => {
    // Red on removing the gate from POST /step-up/email/begin, or on moving it
    // after the begin: the refused call mails the owner and spends the one
    // link the ceiling allows, so the live begin is refused.
    const h = makeApp({ stepUpLinkCeiling: capOf(1) });
    const { profile, ended, live } = await endedAndLive(h, "lsg-sue@example.com", "lsgsue");
    const before = mailTo(h, profile.email);

    expect(
      await answerOf(
        await post(h, "/step-up/email/begin", {
          token: ended.accessToken,
          body: { purpose: "account_export" },
        }),
      ),
    ).toEqual(REFUSED);
    expect(mailTo(h, profile.email)).toBe(before);

    await beginStepUpEmail(h, live.accessToken);
    expect(mailTo(h, profile.email)).toBe(before + 1);
  });

  it("cannot collect a step-up token by email, and the refusal leaves the request", async () => {
    // Red on removing the gate from POST /step-up/email/:requestId/status, or
    // on moving it after the poll: the refused poll claims and spends the
    // confirmed request, and the live session's poll reads expired.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-sus@example.com", "lsgsus");
    const ended = await openSession(h, profile);
    const begun = await beginStepUpEmail(h, ended.accessToken);
    await confirmLink(h, begun);
    await logOut(h, ended.refreshToken);
    const poll = (token: string) =>
      post(h, `/step-up/email/${begun.requestId}/status`, {
        token,
        body: { claimSecret: begun.claimSecret },
      });

    expect(await answerOf(await poll(ended.accessToken))).toEqual(REFUSED);

    const live = await openSession(h, profile);
    expect(await (await poll(live.accessToken)).json()).toMatchObject({
      status: "complete",
      step_up_token: expect.stringMatching(/^eyJ/),
    });
  });

  it("cannot resend a step-up link: no mail, and no ceiling or Resend slot is spent", async () => {
    // Red on removing the gate from POST /step-up/email/:requestId/resend, or
    // on moving it after the resend: the refused call mails the owner and
    // spends the Resend the mailbox has, so the live Resend mails nothing.
    const h = makeApp({ stepUpLinkCeiling: capOf(2), linkResendCap: capOf(1) });
    const profile = await registerAccount(h, "lsg-sur@example.com", "lsgsur");
    const ended = await openSession(h, profile);
    const begun = await beginStepUpEmail(h, ended.accessToken);
    await logOut(h, ended.refreshToken);
    const sent = mailTo(h, profile.email);
    const resend = (token: string) =>
      post(h, `/step-up/email/${begun.requestId}/resend`, {
        token,
        body: { claimSecret: begun.claimSecret },
      });

    expect(await answerOf(await resend(ended.accessToken))).toEqual(REFUSED);
    expect(mailTo(h, profile.email)).toBe(sent);

    const live = await openSession(h, profile);
    expect(await answerOf(await resend(live.accessToken))).toEqual({
      status: 200,
      body: { status: "sent" },
    });
    expect(mailTo(h, profile.email)).toBe(sent + 1);
  });
});

describe("a logged-out session's access token, at the email change routes", () => {
  it("cannot begin a change: no mail, the pending change stands, no begin is spent", async () => {
    // Red on removing the gate from POST /account/email/begin, or on moving it
    // after the begin: the refused call mails the address it names, replaces
    // the live session's pending change and spends a begin.
    const h = makeApp({ emailChangeBeginCap: capOf(2) });
    const { profile, ended, live } = await endedAndLive(h, "lsg-ecb@example.com", "lsgecb");
    const pending = await beginEmailChange(h, live.accessToken, "lsg-ecb-a@example.com");

    expect(
      await answerOf(
        await post(h, "/account/email/begin", {
          token: ended.accessToken,
          body: { new_email: "lsg-ecb-b@example.com" },
        }),
      ),
    ).toEqual(REFUSED);
    expect(mailTo(h, "lsg-ecb-b@example.com")).toBe(0);

    await confirmLink(h, pending);
    const stepUp = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    const done = await post(h, `/account/email/${pending.requestId}/complete`, {
      token: live.accessToken,
      cookie: cookieFor(live.refreshToken),
      body: { claimSecret: pending.claimSecret, step_up_token: stepUp },
    });
    expect(await answerOf(done)).toEqual({ status: 200, body: { email: "lsg-ecb-a@example.com" } });

    await beginEmailChange(h, live.accessToken, "lsg-ecb-c@example.com");
  });

  it("cannot resend a change's link: no mail, and no Resend slot is spent", async () => {
    // Red on removing the gate from POST /account/email/:requestId/resend, or
    // on moving it after the resend.
    const h = makeApp({ linkResendCap: capOf(1) });
    const profile = await registerAccount(h, "lsg-ecr@example.com", "lsgecr");
    const ended = await openSession(h, profile);
    const begun = await beginEmailChange(h, ended.accessToken, "lsg-ecr-new@example.com");
    await logOut(h, ended.refreshToken);
    const sent = mailTo(h, "lsg-ecr-new@example.com");
    const resend = (token: string) =>
      post(h, `/account/email/${begun.requestId}/resend`, {
        token,
        body: { claimSecret: begun.claimSecret },
      });

    expect(await answerOf(await resend(ended.accessToken))).toEqual(REFUSED);
    expect(mailTo(h, "lsg-ecr-new@example.com")).toBe(sent);

    const live = await openSession(h, profile);
    expect(await answerOf(await resend(live.accessToken))).toEqual({
      status: 200,
      body: { status: "sent" },
    });
    expect(mailTo(h, "lsg-ecr-new@example.com")).toBe(sent + 1);
  });

  it("cannot complete a change, and the refusal spends neither the request nor the token", async () => {
    // Red on removing the gate from POST /account/email/:requestId/complete,
    // or on moving it after the change.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-ecc@example.com", "lsgecc");
    const ended = await openSession(h, profile);
    const begun = await beginEmailChange(h, ended.accessToken, "lsg-ecc-new@example.com");
    await confirmLink(h, begun);
    const stepUp = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    await logOut(h, ended.refreshToken);
    const complete = (token: string) =>
      post(h, `/account/email/${begun.requestId}/complete`, {
        token,
        body: { claimSecret: begun.claimSecret, step_up_token: stepUp },
      });

    expect(await answerOf(await complete(ended.accessToken))).toEqual(REFUSED);
    expect(await emailOf(h, profile)).toBe("lsg-ecc@example.com");

    const live = await openSession(h, profile);
    expect(await answerOf(await complete(live.accessToken))).toEqual({
      status: 200,
      body: { email: "lsg-ecc-new@example.com" },
    });
  });

  it("keeps the session the gate found, for a caller that sends no cookie", async () => {
    // Red on sparing the cookie's session rather than the one the gate
    // resolved: a caller admitted by its token's binding alone has no cookie,
    // and the sweep that follows the change signs its own device out.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-ecs@example.com", "lsgecs");
    const caller = await openSession(h, profile);
    const other = await openSession(h, profile);
    const begun = await beginEmailChange(h, caller.accessToken, "lsg-ecs-new@example.com");
    await confirmLink(h, begun);
    const stepUp = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));

    const done = await post(h, `/account/email/${begun.requestId}/complete`, {
      token: caller.accessToken,
      body: { claimSecret: begun.claimSecret, step_up_token: stepUp },
    });
    expect(done.status).toBe(200);
    const left = await sessionIds(h, profile);
    expect(left).toContain(h.auth.hashSessionToken(caller.refreshToken));
    expect(left).not.toContain(h.auth.hashSessionToken(other.refreshToken));
  });
});

describe("POST /profiles/switch", () => {
  it("refuses a logged-out session's token and spends no switch", async () => {
    // Red on removing the gate from POST /profiles/switch, or on letting the
    // refused call reach the per-account cap: the live switches after it are
    // then refused.
    const h = makeApp({ profileSwitchCap: capOf(2) });
    const { profile, ended, live } = await endedAndLive(h, "lsg-sw@example.com", "lsgsw");
    const body = { profile_id: profile.id };

    expect(
      await answerOf(await post(h, "/profiles/switch", { token: ended.accessToken, body })),
    ).toEqual(REFUSED);
    // A live session counts by its token's binding, and by its cookie for a
    // tab whose token predates another tab's renewal.
    expect((await post(h, "/profiles/switch", { token: live.accessToken, body })).status).toBe(200);
    expect(
      (
        await post(h, "/profiles/switch", {
          token: ended.accessToken,
          cookie: cookieFor(live.refreshToken),
          body,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a token with no session binding, sent with no cookie", async () => {
    // Red on letting a caller that names no session through: such a token
    // could otherwise be switched for a fresh one again and again.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-swu@example.com", "lsgswu");
    await openSession(h, profile);
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
      await answerOf(
        await post(h, "/profiles/switch", { token: unbound, body: { profile_id: profile.id } }),
      ),
    ).toEqual(REFUSED);
  });

  it("refuses a logged-out session's token sent with a restricted recovery cookie", async () => {
    // Red on counting a restricted recovery session as live for a switch.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-swr@example.com", "lsgswr");
    const ended = await openSession(h, profile);
    await logOut(h, ended.refreshToken);
    const recovery = await recoverySessionFor(h, profile);

    expect(
      await answerOf(
        await post(h, "/profiles/switch", {
          token: ended.accessToken,
          cookie: cookieFor(recovery.refreshToken),
          body: { profile_id: profile.id },
        }),
      ),
    ).toEqual(REFUSED);
  });

  it("binds the new token to the live ordinary session, not a restricted cookie's", async () => {
    // Red on picking the row to bind from every session of the account: the
    // restricted recovery cookie names a row there, and the new token would
    // be bound to it.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-swb@example.com", "lsgswb");
    const recovery = await recoverySessionFor(h, profile);
    const ordinary = await openSession(h, profile);

    const res = await post(h, "/profiles/switch", {
      token: ordinary.accessToken,
      cookie: cookieFor(recovery.refreshToken),
      body: { profile_id: profile.id },
    });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    const claims = await h.svc(h.auth.verifyAccessToken(access_token));
    expect(claims.sessionBinding).toBe(
      deriveSessionBinding(h.auth.hashSessionToken(ordinary.refreshToken), profile.id),
    );
  });
});

describe("a logged-out session's access token, minting a session or a factor", () => {
  it("cannot approve a cross-device sign-in, and the request stays pending", async () => {
    // Red on removing the gate from POST /login/cross-device/:requestId/approve,
    // or on moving it after the approval: the other device's poll then
    // receives a full session.
    const h = makeApp();
    const { ended, live } = await endedAndLive(h, "lsg-cdl@example.com", "lsgcdl");
    const begun = await post(h, "/login/cross-device/begin", {});
    const { requestId, cdlSecret } = (await begun.json()) as {
      requestId: string;
      cdlSecret: string;
    };
    const approve = (token: string) =>
      post(h, `/login/cross-device/${requestId}/approve`, { token, body: { secret: cdlSecret } });
    const poll = async () =>
      (
        (await (
          await post(h, `/login/cross-device/${requestId}/status`, { body: { secret: cdlSecret } })
        ).json()) as { status: string }
      ).status;

    expect(await answerOf(await approve(ended.accessToken))).toEqual(REFUSED);
    expect(await poll()).toBe("pending");

    expect((await approve(live.accessToken)).status).toBe(200);
    expect(await poll()).toBe("approved");
  });

  it("cannot confirm an authenticator app, and the pending enrolment stays", async () => {
    // Red on removing the gate from POST /totp/enroll/complete, or on moving it
    // after the enrolment.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-tec@example.com", "lsgtec");
    const ended = await openSession(h, profile);
    const stepUp = await h.svc(
      h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"),
    );
    const begun = await post(h, "/totp/enroll/begin", {
      token: ended.accessToken,
      body: { step_up_token: stepUp },
    });
    expect(begun.status).toBe(200);
    const { totpSecret } = (await begun.json()) as { totpSecret: string };
    const code = await deriveTotpCode(
      base32Decode(totpSecret),
      Math.floor(Date.now() / 1000 / STEP_SECONDS),
    );
    await logOut(h, ended.refreshToken);

    expect(
      await answerOf(
        await post(h, "/totp/enroll/complete", { token: ended.accessToken, body: { code } }),
      ),
    ).toEqual(REFUSED);

    const live = await openSession(h, profile);
    expect(
      await answerOf(
        await post(h, "/totp/enroll/complete", { token: live.accessToken, body: { code } }),
      ),
    ).toEqual({ status: 200, body: { enrolled: true } });
  });
});

describe("a logged-out session's access token, at the routes that enrol or register", () => {
  it("cannot begin passkey registration, and the refusal leaves the live session's challenge", async () => {
    // Red on removing the gate from POST /passkey/register/begin for an
    // ordinary caller: the refused begin parks its own challenge over the
    // live session's, so the live registration verifies against another.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-prb@example.com", "lsgprb");
    const begin = (token: string) =>
      post(h, "/passkey/register/begin", { token, body: { profileId: profile.id } });

    const begun = await begin(live.accessToken);
    expect(begun.status).toBe(200);
    const { challenge } = (await begun.json()) as { challenge: string };

    expect(await answerOf(await begin(ended.accessToken))).toEqual(REFUSED);

    const verify = vi.mocked(verifyRegistrationResponse);
    verify.mockClear();
    const done = await post(h, "/passkey/register/complete", {
      token: live.accessToken,
      cookie: cookieFor(live.refreshToken),
      body: {
        profileId: profile.id,
        attestation: { id: "x", rawId: "x", response: {}, type: "public-key" },
      },
    });
    expect(done.status).toBe(200);
    expect(verify.mock.calls.at(-1)?.[0].expectedChallenge).toBe(challenge);
  });

  it("cannot register a relying party, and no client is written", async () => {
    // Red on removing the gate from POST /oidc/clients, or on moving it after
    // the registration: a client secret is minted and a client cap spent.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-oc@example.com", "lsgoc");
    const register = (token: string) =>
      post(h, "/oidc/clients", {
        token,
        body: {
          name: "Gate test",
          redirect_uris: ["https://app.example.com/cb"],
          confidential: true,
        },
      });
    const clients = async () =>
      (
        await h.db
          .select({ id: oauthClients.id })
          .from(oauthClients)
          .where(eq(oauthClients.ownerAccountId, profile.accountId))
      ).length;

    expect(await answerOf(await register(ended.accessToken))).toEqual(REFUSED);
    expect(await clients()).toBe(0);

    expect((await register(live.accessToken)).status).toBe(201);
    expect(await clients()).toBe(1);
  });

  it("cannot begin authenticator-app enrolment, and the live session's pending secret stays", async () => {
    // Red on removing the gate from POST /totp/enroll/begin, or on moving it
    // after the begin: the refused begin replaces the pending secret, so the
    // live session's code no longer confirms.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-teb@example.com", "lsgteb");
    const stepUp = () =>
      h.svc(h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"));
    const begun = await post(h, "/totp/enroll/begin", {
      token: live.accessToken,
      body: { step_up_token: await stepUp() },
    });
    expect(begun.status).toBe(200);
    const { totpSecret } = (await begun.json()) as { totpSecret: string };

    expect(
      await answerOf(
        await post(h, "/totp/enroll/begin", {
          token: ended.accessToken,
          body: { step_up_token: await stepUp() },
        }),
      ),
    ).toEqual(REFUSED);

    const code = await deriveTotpCode(
      base32Decode(totpSecret),
      Math.floor(Date.now() / 1000 / STEP_SECONDS),
    );
    expect(
      await answerOf(
        await post(h, "/totp/enroll/complete", { token: live.accessToken, body: { code } }),
      ),
    ).toEqual({ status: 200, body: { enrolled: true } });
  });
});

/**
 * One row per route that checks the session: what it needs set up by the live
 * session, and the call. Each row is sent twice with a logged-out session's
 * token: alone, which is refused and counted under the row's endpoint name,
 * then with the live session's cookie, which the route serves.
 */
interface GatedCall {
  readonly endpoint: string;
  readonly passkey?: true;
  readonly prepare: (
    h: Harness,
    profile: Profile,
    live: { accessToken: string; refreshToken: string },
    credentialId: string | null,
  ) => Promise<{
    path: string;
    body?: unknown;
    ok: number;
    /** The served answer's body, where the status alone cannot show a spend. */
    served?: unknown;
    method?: string;
    headers?: Record<string, string>;
  }>;
}

const GATED: readonly GatedCall[] = [
  {
    endpoint: "step_up_passkey_begin",
    passkey: true,
    prepare: async () => ({ path: "/step-up/passkey/begin", body: {}, ok: 200 }),
  },
  {
    endpoint: "step_up_passkey_complete",
    passkey: true,
    prepare: async (h, _profile, live, credentialId) => {
      expect((await post(h, "/step-up/passkey/begin", { token: live.accessToken })).status).toBe(
        200,
      );
      return {
        path: "/step-up/passkey/complete",
        body: { assertion: assertionFor(credentialId!), purpose: "recovery_generate" },
        ok: 200,
      };
    },
  },
  {
    endpoint: "step_up_email_begin",
    prepare: async () => ({
      path: "/step-up/email/begin",
      body: { purpose: "account_export" },
      ok: 200,
    }),
  },
  {
    endpoint: "step_up_email_status",
    prepare: async (h, _profile, live) => {
      const begun = await beginStepUpEmail(h, live.accessToken);
      return {
        path: `/step-up/email/${begun.requestId}/status`,
        body: { claimSecret: begun.claimSecret },
        ok: 200,
      };
    },
  },
  {
    endpoint: "step_up_email_resend",
    prepare: async (h, _profile, live) => {
      const begun = await beginStepUpEmail(h, live.accessToken);
      return {
        path: `/step-up/email/${begun.requestId}/resend`,
        body: { claimSecret: begun.claimSecret },
        ok: 200,
      };
    },
  },
  {
    endpoint: "step_up_totp_complete",
    prepare: async (h, profile, live) => ({
      path: "/step-up/totp/complete",
      body: { code: await enrolTotp(h, profile, live.accessToken), purpose: "recovery_generate" },
      ok: 200,
    }),
  },
  {
    endpoint: "recovery_generate",
    prepare: async (h, profile) => ({
      path: "/recovery/generate",
      body: { step_up_token: await recoveryStepUp(h, profile) },
      ok: 200,
    }),
  },
  {
    endpoint: "email_change_begin",
    prepare: async (_h, profile) => ({
      path: "/account/email/begin",
      body: { new_email: `new-${profile.handle}@example.com` },
      ok: 200,
    }),
  },
  {
    endpoint: "email_change_resend",
    prepare: async (h, profile, live) => {
      const begun = await beginEmailChange(
        h,
        live.accessToken,
        `new-${profile.handle}@example.com`,
      );
      return {
        path: `/account/email/${begun.requestId}/resend`,
        body: { claimSecret: begun.claimSecret },
        ok: 200,
      };
    },
  },
  {
    endpoint: "email_change_complete",
    prepare: async (h, profile, live) => {
      const begun = await beginEmailChange(
        h,
        live.accessToken,
        `new-${profile.handle}@example.com`,
      );
      await confirmLink(h, begun);
      return {
        path: `/account/email/${begun.requestId}/complete`,
        body: {
          claimSecret: begun.claimSecret,
          step_up_token: await h.svc(
            h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"),
          ),
        },
        ok: 200,
      };
    },
  },
  {
    endpoint: "profile_switch",
    prepare: async (_h, profile) => ({
      path: "/profiles/switch",
      body: { profile_id: profile.id },
      ok: 200,
    }),
  },
  {
    endpoint: "cross_device_approve",
    prepare: async (h) => {
      const begun = (await (await post(h, "/login/cross-device/begin", {})).json()) as {
        requestId: string;
        cdlSecret: string;
      };
      return {
        path: `/login/cross-device/${begun.requestId}/approve`,
        body: { secret: begun.cdlSecret },
        ok: 200,
      };
    },
  },
  {
    endpoint: "totp_enroll_begin",
    prepare: async (h, profile) => ({
      path: "/totp/enroll/begin",
      body: {
        step_up_token: await h.svc(
          h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"),
        ),
      },
      ok: 200,
    }),
  },
  {
    endpoint: "totp_enroll_complete",
    prepare: async (h, profile, live) => {
      const begun = await post(h, "/totp/enroll/begin", {
        token: live.accessToken,
        body: {
          step_up_token: await h.svc(
            h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll"),
          ),
        },
      });
      const { totpSecret } = (await begun.json()) as { totpSecret: string };
      const code = await deriveTotpCode(
        base32Decode(totpSecret),
        Math.floor(Date.now() / 1000 / STEP_SECONDS),
      );
      return { path: "/totp/enroll/complete", body: { code }, ok: 200 };
    },
  },
  {
    endpoint: "passkey_register_begin",
    prepare: async (_h, profile) => ({
      path: "/passkey/register/begin",
      body: { profileId: profile.id },
      ok: 200,
    }),
  },
  {
    endpoint: "oidc_client_create",
    prepare: async () => ({
      path: "/oidc/clients",
      body: { name: "Gate test", redirect_uris: ["https://app.example.com/cb"] },
      ok: 201,
    }),
  },
  {
    endpoint: "account_delete",
    prepare: async (h, profile) => ({
      method: "DELETE",
      path: "/account",
      body: {
        confirm_handle: profile.handle,
        step_up_token: await h.svc(
          h.auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
        ),
      },
      ok: 202,
    }),
  },
  {
    endpoint: "account_restore",
    prepare: async (h, profile, live) => {
      const scheduled = await send(h, "DELETE", "/account", {
        token: live.accessToken,
        cookie: cookieFor(live.refreshToken),
        body: {
          confirm_handle: profile.handle,
          step_up_token: await h.svc(
            h.auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
          ),
        },
      });
      expect(scheduled.status).toBe(202);
      // `cancelled: true` only if the refused call cancelled nothing.
      return { path: "/account/restore", ok: 200, served: { cancelled: true } };
    },
  },
  {
    endpoint: "account_export",
    prepare: async (h, profile) => ({
      method: "GET",
      path: "/account/export",
      headers: {
        "x-step-up-token": await h.svc(
          h.auth.issueStepUpToken(profile.accountId, "otp", "account_export"),
        ),
      },
      ok: 200,
    }),
  },
  {
    endpoint: "security_event_ack",
    prepare: async (h, profile) => {
      const id = "sev_" + "a".repeat(12);
      await h.db.insert(securityEvents).values({
        id,
        accountId: profile.accountId,
        kind: "passkey_registered",
        createdAt: Math.floor(Date.now() / 1000),
      });
      return {
        path: `/account/security-events/${id}/ack`,
        body: {
          step_up_token: await h.svc(
            h.auth.issueStepUpToken(profile.accountId, "otp", "security_event_ack"),
          ),
        },
        ok: 200,
      };
    },
  },
  {
    endpoint: "security_event_ack_all",
    prepare: async (h, profile) => ({
      path: "/account/security-events/ack-all",
      body: {
        step_up_token: await h.svc(
          h.auth.issueStepUpToken(profile.accountId, "otp", "security_event_ack"),
        ),
      },
      ok: 200,
    }),
  },
  {
    endpoint: "totp_disable",
    prepare: async (h, profile, live) => {
      await enrolTotp(h, profile, live.accessToken);
      return {
        method: "DELETE",
        path: "/totp",
        body: {
          step_up_token: await h.svc(
            h.auth.issueStepUpToken(profile.accountId, "otp", "totp_disable"),
          ),
        },
        ok: 200,
      };
    },
  },
  {
    endpoint: "passkey_rename",
    passkey: true,
    prepare: async (h, profile) => {
      const target = await newestPasskey(h, profile);
      return {
        method: "PATCH",
        path: `/passkeys/${target.id}`,
        body: { label: "Renamed", step_up_token: await passkeyMutationStepUp(h, profile, target) },
        ok: 200,
      };
    },
  },
  {
    endpoint: "passkey_delete",
    passkey: true,
    prepare: async (h, profile) => {
      const target = await newestPasskey(h, profile);
      return {
        method: "DELETE",
        path: `/passkeys/${target.id}`,
        body: { step_up_token: await passkeyMutationStepUp(h, profile, target) },
        ok: 200,
      };
    },
  },
  {
    endpoint: "session_revoke",
    prepare: async (h, profile) => {
      const target = await openSession(h, profile);
      return {
        method: "DELETE",
        path: `/sessions/${sessionHandleFromHash(h.auth.hashSessionToken(target.refreshToken))}`,
        ok: 200,
      };
    },
  },
  {
    endpoint: "session_revoke_others",
    prepare: async (h, profile) => {
      await openSession(h, profile);
      return { path: "/sessions/revoke-all-other", ok: 200 };
    },
  },
];

/** The account's newest passkey row, as the passkey routes name it. */
async function newestPasskey(h: Harness, profile: Profile) {
  const rows = await h.db
    .select({ id: passkeys.id, createdAt: passkeys.createdAt })
    .from(passkeys)
    .where(eq(passkeys.accountId, profile.accountId));
  return rows.at(-1)!;
}

/**
 * A `passkey_delete` step-up token minted by asserting `target` itself, which
 * the cooldown on older credentials never refuses.
 */
const passkeyMutationStepUp = (
  h: Harness,
  profile: Profile,
  target: { id: string; createdAt: Date | number },
) =>
  h.svc(
    h.auth.issueStepUpToken(profile.accountId, "passkey", "passkey_delete", {
      id: target.id,
      provenance: "webauthn",
      createdAt:
        target.createdAt instanceof Date
          ? Math.floor(target.createdAt.getTime() / 1000)
          : target.createdAt,
    }),
  );

describe("every gated route, for a logged-out session's token", () => {
  it.each(GATED.map((row, i) => [row.endpoint, row, i] as const))(
    "%s refuses it, counted under its own name, and serves it with a live cookie",
    async (endpoint, row, i) => {
      // Red on a route that names another endpoint in its gate, or that does
      // not pass the request's cookie to it: the cookie is the only thing that
      // admits the second call.
      const h = makeApp();
      const profile = await registerAccount(h, `lsg-row${i}@example.com`, `lsgrow${i}`);
      const credentialId = row.passkey ? await enrolPasskey(h, profile) : null;
      // A second credential, so the last-passkey guard never decides a row.
      if (row.passkey) await enrolPasskey(h, profile);
      const ended = await openSession(h, profile);
      const live = await openSession(h, profile);
      await logOut(h, ended.refreshToken);
      const call = await row.prepare(h, profile, live, credentialId);

      const method = call.method ?? "POST";
      staleRefusals.length = 0;
      // The ended session's own cookie rides along, as a logged-out tab's
      // might: it names no live session either.
      expect(
        await answerOf(
          await send(h, method, call.path, {
            token: ended.accessToken,
            cookie: cookieFor(ended.refreshToken),
            body: call.body,
            headers: call.headers,
          }),
        ),
      ).toEqual(REFUSED);
      expect(staleRefusals).toEqual([endpoint]);

      // Served with the same body, and so the same step-up token: the
      // refusal spent nothing.
      const served = await send(h, method, call.path, {
        token: ended.accessToken,
        cookie: cookieFor(live.refreshToken),
        body: call.body,
        headers: call.headers,
      });
      expect(served.status).toBe(call.ok);
      const servedBody = call.served === undefined ? undefined : await served.json();
      expect(servedBody).toEqual(call.served);
      // A change of address revokes every session but the caller's device:
      // the one the cookie named stays.
      expect(await sessionIds(h, profile)).toContain(h.auth.hashSessionToken(live.refreshToken));
    },
  );

  it("has a row for every endpoint the gate can count", () => {
    // Red on a gated route with no row above. A name added to
    // `LiveSessionGateEndpoint` fails the type check here until it is listed.
    const every: Record<LiveSessionGateEndpoint, true> = {
      step_up_passkey_begin: true,
      step_up_passkey_complete: true,
      step_up_email_begin: true,
      step_up_email_status: true,
      step_up_email_resend: true,
      step_up_totp_complete: true,
      recovery_generate: true,
      email_change_begin: true,
      email_change_resend: true,
      email_change_complete: true,
      profile_switch: true,
      cross_device_approve: true,
      totp_enroll_begin: true,
      totp_enroll_complete: true,
      passkey_register_begin: true,
      oidc_client_create: true,
      account_delete: true,
      account_restore: true,
      account_export: true,
      security_event_ack: true,
      security_event_ack_all: true,
      totp_disable: true,
      passkey_rename: true,
      passkey_delete: true,
      session_revoke: true,
      session_revoke_others: true,
    };
    expect(GATED.map((r) => r.endpoint).toSorted()).toEqual(Object.keys(every).toSorted());
  });
});

describe("when the cookie and the token's binding name two live sessions", () => {
  it("the cookie's session is the one a switch binds to", async () => {
    // Red on trying the binding before the cookie: the browser's own session
    // is the cookie's, and an email change spares the same one.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-two@example.com", "lsgtwo");
    const a = await openSession(h, profile);
    const b = await openSession(h, profile);

    const res = await post(h, "/profiles/switch", {
      token: a.accessToken,
      cookie: cookieFor(b.refreshToken),
      body: { profile_id: profile.id },
    });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    const claims = await h.svc(h.auth.verifyAccessToken(access_token));
    expect(claims.sessionBinding).toBe(
      deriveSessionBinding(h.auth.hashSessionToken(b.refreshToken), profile.id),
    );
  });
});

describe("the revocation routes, and the sessions they spare", () => {
  it("sign-out-everywhere refused for a logged-out session revokes nothing", async () => {
    // Red on moving the gate after the revoke in POST /sessions/revoke-all-other.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-rao@example.com", "lsgrao");
    expect(
      await answerOf(
        await post(h, "/sessions/revoke-all-other", {
          token: ended.accessToken,
          cookie: cookieFor(ended.refreshToken),
        }),
      ),
    ).toEqual(REFUSED);
    expect(await sessionIds(h, profile)).toContain(h.auth.hashSessionToken(live.refreshToken));
  });

  it("revoking one session, refused for a logged-out session, revokes nothing", async () => {
    // Red on moving the gate after the revoke in DELETE /sessions/:id.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-rv1@example.com", "lsgrv1");
    const handle = sessionHandleFromHash(h.auth.hashSessionToken(live.refreshToken));
    expect(
      await answerOf(await send(h, "DELETE", `/sessions/${handle}`, { token: ended.accessToken })),
    ).toEqual(REFUSED);
    expect(await sessionIds(h, profile)).toContain(h.auth.hashSessionToken(live.refreshToken));
  });

  it("sign-out-everywhere with a stale cookie spares the session the token is bound to", async () => {
    // Red on sparing the raw cookie's session: a cookie naming no live session
    // spares nothing, and the caller's own device goes with the rest.
    const h = makeApp();
    const { profile, ended, live } = await endedAndLive(h, "lsg-ras@example.com", "lsgras");
    const other = await openSession(h, profile);

    const res = await post(h, "/sessions/revoke-all-other", {
      token: live.accessToken,
      cookie: cookieFor(ended.refreshToken),
    });
    expect(res.status).toBe(200);
    const left = await sessionIds(h, profile);
    expect(left).toContain(h.auth.hashSessionToken(live.refreshToken));
    expect(left).not.toContain(h.auth.hashSessionToken(other.refreshToken));
  });

  it("an account deletion keeps the session the gate found as its cancel handle", async () => {
    // Red on taking the cancel handle from the raw cookie: a caller admitted by
    // its token's binding alone sends none, and the deletion's sweep signs out
    // the very device that could cancel it.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-del@example.com", "lsgdel");
    const caller = await openSession(h, profile);
    const other = await openSession(h, profile);

    const res = await send(h, "DELETE", "/account", {
      token: caller.accessToken,
      body: {
        confirm_handle: profile.handle,
        step_up_token: await h.svc(
          h.auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
        ),
      },
    });
    expect(res.status).toBe(202);
    const left = await sessionIds(h, profile);
    expect(left).toContain(h.auth.hashSessionToken(caller.refreshToken));
    expect(left).not.toContain(h.auth.hashSessionToken(other.refreshToken));
  });
});

describe("a restricted recovery session that has ended", () => {
  it("cannot begin passkey registration, and its step-up token stays unspent", async () => {
    // Red on letting a restricted caller whose session names no row through to
    // the step-up check: the token would be spent before any refusal.
    const h = makeApp();
    const profile = await registerAccount(h, "lsg-rpr@example.com", "lsgrpr");
    await enrolPasskey(h, profile);
    const recovery = await recoverySessionFor(h, profile);
    await h.db
      .delete(sessions)
      .where(eq(sessions.id, h.auth.hashSessionToken(recovery.refreshToken)));
    const stepUp = await h.svc(
      h.auth.issueStepUpToken(profile.accountId, "passkey", "passkey_register"),
    );

    staleRefusals.length = 0;
    expect(
      await answerOf(
        await post(h, "/passkey/register/begin", {
          token: recovery.accessToken,
          cookie: cookieFor(recovery.refreshToken),
          body: { profileId: profile.id, step_up_token: stepUp },
        }),
      ),
    ).toEqual(REFUSED);
    expect(staleRefusals).toEqual(["passkey_register_begin"]);

    const live = await openSession(h, profile);
    const begun = await post(h, "/passkey/register/begin", {
      token: live.accessToken,
      body: { profileId: profile.id, step_up_token: stepUp },
    });
    expect(begun.status).toBe(200);
  });
});
