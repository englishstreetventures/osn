/**
 * The post-recovery cooldown, and the disown lever that makes it survivable.
 *
 * The rule this file pins is asymmetric on purpose, and the asymmetry is the
 * whole design: an attacker holding the mailbox always moves FIRST — they
 * recover, every other session is revoked, they enrol their own passkey — so a
 * symmetric lock on passkey deletion hands them the window it was meant to give
 * the owner. A credential that PREDATES the recovery therefore acts
 * immediately, and one the recovery produced waits.
 *
 * Most of these guards fail silently when they break. A cooldown that never
 * fires looks exactly like one that is not needed; a second recovery that is
 * allowed answers the same bytes as one that is refused; a disown that revokes
 * nothing returns 202 like one that revokes everything. So each test below
 * names, in its comment, the edit that turns it red.
 *
 * See `wiki/architecture/account-recovery-factors.md` §D.
 */

import { Database } from "bun:sqlite";

import { accounts, passkeys, sessions } from "@osn/db/schema";
import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { makeLogEmailLive, type RecordedEmail } from "@shared/email";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Every `metricRecoveryDisown` call, in order.
 *
 * The counter goes to a NoOp meter under test, and it is the ONLY signal that
 * separates a disown that revoked something from one that revoked nothing —
 * every branch that a stranger can reach answers the same 202. So the outcome
 * has to be observable here, or the tests below can only assert that the route
 * did not crash. The spy calls through, so nothing else changes.
 */
const disownOutcomes = vi.hoisted(() => [] as string[]);
vi.mock("../../src/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/metrics")>();
  return {
    ...actual,
    metricRecoveryDisown: (result: string) => {
      disownOutcomes.push(result);
      actual.metricRecoveryDisown(result as Parameters<typeof actual.metricRecoveryDisown>[0]);
    },
  };
});

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
            id: `cd-cred-${seq}-${Math.random().toString(16).slice(2, 10)}`,
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
      authenticationInfo: { newCounter: 1 },
    })),
  };
});

const { createAuthService } = await import("../../src/services/auth");
const { RECOVERY_COOLDOWN_MS } = await import("../../src/services/auth/constants");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createAuthRoutes } = await import("../helpers/routes");

type AuthConfig = Awaited<ReturnType<typeof makeTestAuthConfig>>;

let config: AuthConfig;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const json = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * `wrapDb` is how the database-failure tests reach the routes: the service the
 * routes hold is built over whatever it returns, while the tests keep the real
 * handle to assert against.
 */
function makeApp(overrides: Partial<AuthConfig> = {}, wrapDb: (db: TestDb) => TestDb = (d) => d) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  const recorder = makeLogEmailLive();
  const routeLayer = Layer.merge(Layer.succeed(Db, { db: wrapDb(db) }), recorder.layer);
  // The tests' own reads and seeds always go through the real handle, so a
  // wrapped database can fail the routes without blinding the assertions.
  const testLayer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);
  const merged = { ...config, ...overrides };
  const app = createAuthRoutes(merged, routeLayer);
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);
  return { app, auth, db, svc, recorded: recorder.recorded };
}

const post = (app: { handle: (r: Request) => Promise<Response> }, path: string, body: unknown) =>
  app.handle(json(path, { method: "POST", body: JSON.stringify(body) }));

const codeOf = (text: string): string => {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match) throw new Error("no 6-digit code in the recorded email");
  return match[1]!;
};

const otpCodes = (recorded: readonly RecordedEmail[]) =>
  recorded.filter((r) => r.template === "otp-recovery").map((r) => codeOf(r.text));

/** Drive `begin` and wait for the detached send to land. */
async function requestCode(
  app: { handle: (r: Request) => Promise<Response> },
  recorded: () => readonly RecordedEmail[],
  identifier: string,
): Promise<string> {
  const before = otpCodes(recorded()).length;
  const res = await post(app, "/login/recovery/email/begin", { identifier });
  expect(res.status).toBe(202);
  for (let i = 0; i < 100 && otpCodes(recorded()).length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return otpCodes(recorded()).at(-1)!;
}

/** Wait for the detached notice, then pull the disown token out of its link. */
async function disownTokenFrom(recorded: () => readonly RecordedEmail[]): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const notice = recorded().find((r) => r.template === "recovery-used");
    if (notice) {
      const match = /#token=([^\s"<]+)/.exec(notice.text + notice.html);
      if (!match) throw new Error("recovery-used notice carried no disown token");
      return decodeURIComponent(match[1]!);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("no recovery-used notice was sent");
}

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

// ---------------------------------------------------------------------------

describe("the cooldown is asymmetric — the owner acts, the recovery waits", () => {
  it("a PRE-recovery passkey deletes a pre-recovery passkey immediately after a recovery", async () => {
    // The case the whole design exists for. Goes red on making the rule
    // symmetric — gating on `lastRecoveredAt` alone without asking whose
    // credential is asking.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("cd-owner@example.com", "cdowner"));

    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    // The second enrolment is past the bootstrap, so it needs a step-up. A
    // `webauthn` one, asserting the first credential — this is ordinary
    // rotation, and both credentials end up with `webauthn` provenance.
    const [first] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ credentialId: passkeys.credentialId })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    await h.svc(h.auth.beginStepUpPasskey(profile.accountId));
    const { stepUpToken: registerToken } = await h.svc(
      h.auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(first!.credentialId),
        "passkey_register",
      ),
    );
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId, registerToken));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    const owned = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id, credentialId: passkeys.credentialId })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    expect(owned).toHaveLength(2);

    // A recovery happens (the attacker's, or the owner's — the rule cannot
    // tell, and must not need to).
    const code = await requestCode(h.app, h.recorded, "cd-owner@example.com");
    const done = await post(h.app, "/login/recovery/email/complete", {
      identifier: "cd-owner@example.com",
      code,
    });
    expect(done.status).toBe(200);

    // The owner asserts a credential that predates it. Unrestricted.
    await h.svc(h.auth.beginStepUpPasskey(profile.accountId));
    const { stepUpToken } = await h.svc(
      h.auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(owned[0]!.credentialId),
        "passkey_delete",
      ),
    );
    await h.svc(h.auth.verifyStepUpForPasskeyDelete(profile.accountId, stepUpToken, owned[1]!.id));
  });

  it("the recovery-enrolled passkey is refused against a pre-recovery one, then permitted", async () => {
    // Goes red on dropping the `recovery` value from the weak-provenance set,
    // or on stamping the recovery-session bypass `webauthn`.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("cd-enrol@example.com", "cdenrol"));
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    const [original] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );

    const code = await requestCode(h.app, h.recorded, "cd-enrol@example.com");
    const done = await post(h.app, "/login/recovery/email/complete", {
      identifier: "cd-enrol@example.com",
      code,
    });
    const body = (await done.json()) as { session: { access_token: string } };

    // Enrol through the restricted recovery session — the bypass, no step-up.
    const enrolled = await h.app.handle(
      json("/passkey/register/begin", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id }),
      }),
    );
    expect(enrolled.status).toBe(200);
    await h.app.handle(
      json("/passkey/register/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id, attestation: {} }),
      }),
    );

    const rows = await h.svc(
      Effect.promise(() =>
        h.db
          .select({
            id: passkeys.id,
            credentialId: passkeys.credentialId,
            provenanceAmr: passkeys.provenanceAmr,
            createdAt: passkeys.createdAt,
          })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    const fresh = rows.find((r) => r.id !== original!.id)!;
    expect(fresh.provenanceAmr).toBe("recovery");

    await h.svc(h.auth.beginStepUpPasskey(profile.accountId));
    const first = await h.svc(
      h.auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(fresh.credentialId),
        "passkey_delete",
      ),
    );
    const err = await h
      .svc(h.auth.verifyStepUpForPasskeyDelete(profile.accountId, first.stepUpToken, original!.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();

    // Age the credential past its window; the same chain now succeeds.
    await h.svc(
      Effect.promise(() =>
        h.db
          .update(passkeys)
          .set({ createdAt: new Date(Date.now() - RECOVERY_COOLDOWN_MS - 60_000) })
          .where(eq(passkeys.id, fresh.id)),
      ),
    );
    await h.svc(
      Effect.promise(() =>
        h.db
          .update(accounts)
          .set({ lastRecoveredAt: Math.floor((Date.now() - RECOVERY_COOLDOWN_MS - 60_000) / 1000) })
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    await h.svc(h.auth.beginStepUpPasskey(profile.accountId));
    const second = await h.svc(
      h.auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(fresh.credentialId),
        "passkey_delete",
      ),
    );
    await h.svc(
      h.auth.verifyStepUpForPasskeyDelete(profile.accountId, second.stepUpToken, original!.id),
    );
  });

  it("an otp step-up cannot change the email inside the window, and can outside it", async () => {
    // The reason `emailChangeAllowedAmr` admits `otp` at all is that an emailed
    // code proves control of the CURRENT mailbox — which a recovery is exactly
    // the event that calls into question. Goes red on dropping the W2 arm from
    // `provenanceRefusal`.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("cd-ec@example.com", "cdec"));

    // No recovery on record: the ordinary path is untouched.
    const before = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    await h.svc(h.auth.verifyStepUpForEmailChange(profile.accountId, before));

    await h.svc(
      Effect.promise(() =>
        h.db
          .update(accounts)
          .set({ lastRecoveredAt: Math.floor(Date.now() / 1000) })
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    const inside = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    const err = await h.svc(h.auth.verifyStepUpForEmailChange(profile.accountId, inside)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();

    await h.svc(
      Effect.promise(() =>
        h.db
          .update(accounts)
          .set({ lastRecoveredAt: Math.floor((Date.now() - RECOVERY_COOLDOWN_MS - 60_000) / 1000) })
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    const after = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    await h.svc(h.auth.verifyStepUpForEmailChange(profile.accountId, after));
  });
});

describe("one recovery per account per 72 hours", () => {
  it("a second email recovery inside the window is refused, and begin still answers 202", async () => {
    // Goes red on removing the `previousRecovery` guard in
    // `completeRecoveryFactor`. The `begin` assertion is the other half: the
    // refusal must not become an account-existence oracle.
    const h = makeApp();
    await h.svc(h.auth.registerProfile("cd-second@example.com", "cdsecond"));

    const first = await requestCode(h.app, h.recorded, "cd-second@example.com");
    const one = await post(h.app, "/login/recovery/email/complete", {
      identifier: "cd-second@example.com",
      code: first,
    });
    expect(one.status).toBe(200);

    const again = await requestCode(h.app, h.recorded, "cd-second@example.com");
    const two = await post(h.app, "/login/recovery/email/complete", {
      identifier: "cd-second@example.com",
      code: again,
    });
    expect(two.status).toBe(400);
    expect(await two.json()).toEqual({ error: "invalid_request" });

    // `begin` is unchanged: still 202, still indistinguishable.
    const beginAgain = await post(h.app, "/login/recovery/email/begin", {
      identifier: "cd-second@example.com",
    });
    expect(beginAgain.status).toBe(202);
    expect(await beginAgain.json()).toEqual({ status: "accepted" });
  });

  it("the recovery-CODE path is NOT refused inside the window, and stamps it", async () => {
    // Deviation (a), pinned. Capping this path would shut the owner's only
    // unauthenticated door for three days — the one door a mailbox holder
    // cannot open. Goes red on moving the second-recovery guard into
    // `consumeRecoveryCode`, which is the obvious "apply it to all three
    // paths" reading of the issue.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("cd-code@example.com", "cdcode"));
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));

    // An email recovery opens the window.
    const code = await requestCode(h.app, h.recorded, "cd-code@example.com");
    await post(h.app, "/login/recovery/email/complete", {
      identifier: "cd-code@example.com",
      code,
    });
    const [stamped] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    expect(stamped!.lastRecoveredAt).not.toBeNull();

    // The owner's printed codes still work, inside that window.
    const stepUp = await h.svc(
      h.auth.issueStepUpToken(profile.accountId, "otp", "recovery_generate"),
    );
    const generated = await h.svc(
      h.auth.generateRecoveryCodesForAccount(profile.accountId).pipe(Effect.tap(() => Effect.void)),
    );
    void stepUp;
    const recoveryLogin = await post(h.app, "/login/recovery/complete", {
      identifier: "cd-code@example.com",
      code: generated.recoveryCodes[0]!,
    });
    expect(recoveryLogin.status).toBe(200);
  });

  it("the recovery-code path stamps the window it is exempt from", async () => {
    // Both halves matter: exempt from the CAP, but it still opens the window
    // the email-change gate reads. Goes red on dropping the `accounts` update
    // from `consumeRecoveryCode`'s batch.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("cd-stamp@example.com", "cdstamp"));
    const generated = await h.svc(h.auth.generateRecoveryCodesForAccount(profile.accountId));

    const res = await post(h.app, "/login/recovery/complete", {
      identifier: "cd-stamp@example.com",
      code: generated.recoveryCodes[0]!,
    });
    expect(res.status).toBe(200);

    const [row] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    expect(row!.lastRecoveredAt).not.toBeNull();

    // And the window it opened is live: an otp step-up cannot change the email.
    const token = await h.svc(h.auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    const err = await h.svc(h.auth.verifyStepUpForEmailChange(profile.accountId, token)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
  });
});

describe("POST /recovery/disown", () => {
  /** Recover, enrol through the bypass, and hand back everything the tests need. */
  async function recoverAndEnrol(h: ReturnType<typeof makeApp>, email: string, handle: string) {
    const profile = await h.svc(h.auth.registerProfile(email, handle));
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    const [original] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );

    const code = await requestCode(h.app, h.recorded, email);
    const done = await post(h.app, "/login/recovery/email/complete", { identifier: email, code });
    const body = (await done.json()) as { session: { access_token: string } };
    await h.app.handle(
      json("/passkey/register/begin", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id }),
      }),
    );
    await h.app.handle(
      json("/passkey/register/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id, attestation: {} }),
      }),
    );
    const token = await disownTokenFrom(h.recorded);
    return { profile, original: original!, token };
  }

  const passkeyIds = (h: ReturnType<typeof makeApp>, accountId: string) =>
    h.svc(
      Effect.promise(() =>
        h.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.accountId, accountId)),
      ),
    );

  it("revokes the recovery-enrolled credential, every session, and the window", async () => {
    // Goes red on any of the three: dropping the passkey delete, the session
    // delete, or the `lastRecoveredAt: null` update.
    const h = makeApp();
    const { profile, original, token } = await recoverAndEnrol(h, "dis-ok@example.com", "disok");
    expect(await passkeyIds(h, profile.accountId)).toHaveLength(2);

    const res = await post(h.app, "/recovery/disown", { token });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });

    const after = await passkeyIds(h, profile.accountId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(original.id);

    const liveSessions = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.accountId, profile.accountId)),
      ),
    );
    expect(liveSessions).toHaveLength(0);

    const [row] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    expect(row!.lastRecoveredAt).toBeNull();

    // Clearing the window is what stops one click becoming a 72-hour lockout:
    // the owner can recover again straight away.
    const code = await requestCode(h.app, h.recorded, "dis-ok@example.com");
    const again = await post(h.app, "/login/recovery/email/complete", {
      identifier: "dis-ok@example.com",
      code,
    });
    expect(again.status).toBe(200);
  });

  it("is single use, and an expired or wrong token changes nothing", async () => {
    // Goes red on deleting the store entry after the revocation instead of
    // before it, or on comparing the secret with `===` against a stored
    // plaintext.
    const h = makeApp();
    const { profile, token } = await recoverAndEnrol(h, "dis-once@example.com", "disonce");

    expect((await post(h.app, "/recovery/disown", { token })).status).toBe(202);

    // The replay has to be measured against state the FIRST call did not
    // already reach. Asserting "the passkey count is unchanged" proves nothing:
    // the credential is gone, so a second run is a no-op whether or not the
    // token was consumed. So recover again — which the first disown made
    // possible by clearing the window — and then replay the spent token. It
    // carries the OLD `recoveredAt`, so a token that still worked would revoke
    // the new recovery's credential and clear the new window with it.
    const code = await requestCode(h.app, h.recorded, "dis-once@example.com");
    const again = await post(h.app, "/login/recovery/email/complete", {
      identifier: "dis-once@example.com",
      code,
    });
    expect(again.status).toBe(200);

    expect((await post(h.app, "/recovery/disown", { token })).status).toBe(202);
    const [row] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    expect(row!.lastRecoveredAt).not.toBeNull();

    // A wrong secret against a real lookup id.
    const h2 = makeApp();
    const second = await recoverAndEnrol(h2, "dis-wrong@example.com", "diswrong");
    const [lookupId] = second.token.split(".");
    const forged = `${lookupId}.${"A".repeat(43)}`;
    const res = await post(h2.app, "/recovery/disown", { token: forged });
    expect(res.status).toBe(202);
    expect(await passkeyIds(h2, second.profile.accountId)).toHaveLength(2);

    // Garbage that is not even the right shape.
    const junk = await post(h2.app, "/recovery/disown", { token: "not-a-token" });
    expect(junk.status).toBe(202);
    expect(await passkeyIds(h2, second.profile.accountId)).toHaveLength(2);
  });

  it("never drops the account below one passkey", async () => {
    // The account's only credential is the one the recovery enrolled. The
    // invariant wins; the sessions still go. Goes red on removing the
    // `keepsOne` guard.
    const h = makeApp();
    const profile = await h.svc(h.auth.registerProfile("dis-last@example.com", "dislast"));

    const code = await requestCode(h.app, h.recorded, "dis-last@example.com");
    const done = await post(h.app, "/login/recovery/email/complete", {
      identifier: "dis-last@example.com",
      code,
    });
    const body = (await done.json()) as { session: { access_token: string } };
    // No passkey existed, so this is a bootstrap enrolment — but it still
    // postdates the recovery. Force the weak provenance the disown filters on.
    await h.app.handle(
      json("/passkey/register/begin", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id }),
      }),
    );
    await h.app.handle(
      json("/passkey/register/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id, attestation: {} }),
      }),
    );
    await h.svc(
      Effect.promise(() =>
        h.db
          .update(passkeys)
          .set({ provenanceAmr: "recovery" })
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    expect(await passkeyIds(h, profile.accountId)).toHaveLength(1);

    const token = await disownTokenFrom(h.recorded);
    const res = await post(h.app, "/recovery/disown", { token });
    expect(res.status).toBe(202);

    expect(await passkeyIds(h, profile.accountId)).toHaveLength(1);
    const liveSessions = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.accountId, profile.accountId)),
      ),
    );
    expect(liveSessions).toHaveLength(0);
  });

  it("cannot reach past a LATER recovery — neither its credentials nor its window", async () => {
    // The two documented exclusions interact. A token freezes `recovered_at`
    // at mint time and lives 72 hours; the recovery-CODE path is exempt from
    // the one-per-72-hours cap and re-stamps `last_recovered_at` every time.
    // So a second, legitimate recovery can land while an older token is still
    // live, and an unscoped run would revoke the credentials that second
    // recovery produced and clear a window belonging to it — ending W2 early
    // for a recovery nobody disowned, which re-opens both the second-recovery
    // cap and the email-change gate for whoever holds the mailbox.
    //
    // Goes red on dropping either bound: the `laterRecovery` upper bound on
    // the revocable set, or the compare-and-set on the `last_recovered_at`
    // clear.
    const h = makeApp();
    const { profile, original, token } = await recoverAndEnrol(
      h,
      "dis-later@example.com",
      "dislater",
    );

    // The second recovery is stood in for by the two writes one performs: it
    // stamps `last_recovered_at` (proved against the real route by "the
    // recovery-code path stamps the window it is exempt from") and leaves a
    // credential behind. Five seconds later, because the column is unix
    // SECONDS and two recoveries inside one second are one recovery to every
    // comparison here.
    const [firstStamp] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    const secondRecoveryAt = firstStamp!.lastRecoveredAt! + 5;
    const secondCredential = `pk_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
    await h.svc(
      Effect.promise(async () => {
        await h.db
          .update(accounts)
          .set({ lastRecoveredAt: secondRecoveryAt })
          .where(eq(accounts.id, profile.accountId));
        await h.db.insert(passkeys).values({
          id: secondCredential,
          accountId: profile.accountId,
          credentialId: `cred-${secondCredential}`,
          publicKey: "AAAA",
          counter: 0,
          transports: null,
          createdAt: new Date(secondRecoveryAt * 1000),
          label: null,
          lastUsedAt: null,
          aaguid: null,
          backupEligible: false,
          backupState: false,
          provenanceAmr: "recovery",
        });
      }),
    );

    expect((await post(h.app, "/recovery/disown", { token })).status).toBe(202);

    // The first recovery's credential goes. The second's stays, and so does the
    // pre-recovery original.
    const after = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    expect(after.map((r) => r.id).toSorted()).toEqual([original.id, secondCredential].toSorted());

    // And the second recovery keeps its own 72 hours.
    const [row] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ lastRecoveredAt: accounts.lastRecoveredAt })
          .from(accounts)
          .where(eq(accounts.id, profile.accountId)),
      ),
    );
    expect(row!.lastRecoveredAt).toBe(secondRecoveryAt);
  });

  it("spares a post-recovery credential the owner enrolled with a real passkey", async () => {
    // The filter is on provenance as well as time. A bare
    // `created_at >= recoveredAt` would delete the credential the owner added
    // afterwards by asserting a passkey they still hold — which is the one
    // thing they most need to keep. Goes red on dropping the provenance
    // predicate from `revokeDisownedRecovery`.
    const h = makeApp();
    const { profile, token } = await recoverAndEnrol(h, "dis-keep@example.com", "diskeep");

    // The owner returns, asserts their surviving original, and enrols a
    // replacement — provenance `webauthn`, created after the recovery.
    const rows = await h.svc(
      Effect.promise(() =>
        h.db
          .select({
            id: passkeys.id,
            credentialId: passkeys.credentialId,
            provenanceAmr: passkeys.provenanceAmr,
          })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    const owned = rows.find((r) => r.provenanceAmr === "webauthn")!;
    await h.svc(h.auth.beginStepUpPasskey(profile.accountId));
    const { stepUpToken } = await h.svc(
      h.auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(owned.credentialId),
        "passkey_register",
      ),
    );
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId, stepUpToken));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    expect(await passkeyIds(h, profile.accountId)).toHaveLength(3);

    await post(h.app, "/recovery/disown", { token });

    const after = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id, provenanceAmr: passkeys.provenanceAmr })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    // The recovery-enrolled one goes; both `webauthn` credentials stay.
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.provenanceAmr === "webauthn")).toBe(true);
  });
});

/**
 * The gate, reached the way a browser reaches it.
 *
 * Everything above verifies `provenanceRefusal` through the service layer. That
 * leaves two joints unproven, and both are the kind that fail silently: whether
 * `params.id` from the URL actually becomes the target the rule compares
 * against, and whether a refusal surfaces as an HTTP status rather than an
 * unhandled rejection. A gate wired to the wrong id refuses nothing and every
 * service test still passes.
 *
 * Each case below sends the SAME token twice and changes only the `:id`, so a
 * route that ignored the parameter would have to answer both the same way.
 */
describe("the provenance gate through the routes", () => {
  /** Recover, enrol through the bypass, and return both credentials + a session. */
  async function recoveredAccount(h: ReturnType<typeof makeApp>, email: string, handle: string) {
    const profile = await h.svc(h.auth.registerProfile(email, handle));
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));
    const [original] = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );

    const code = await requestCode(h.app, h.recorded, email);
    const done = await post(h.app, "/login/recovery/email/complete", { identifier: email, code });
    const body = (await done.json()) as { session: { access_token: string } };
    await h.app.handle(
      json("/passkey/register/begin", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id }),
      }),
    );
    await h.app.handle(
      json("/passkey/register/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id, attestation: {} }),
      }),
    );

    const rows = await h.svc(
      Effect.promise(() =>
        h.db
          .select({ id: passkeys.id, credentialId: passkeys.credentialId })
          .from(passkeys)
          .where(eq(passkeys.accountId, profile.accountId)),
      ),
    );
    const fresh = rows.find((r) => r.id !== original!.id)!;

    // An ordinary session, so the routes have an access token to resolve. The
    // recovery session is restricted and reaches none of these gates.
    const tokens = await h.svc(
      h.auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    return { profile, original: original!, fresh, accessToken: tokens.accessToken };
  }

  /** A `passkey_delete` step-up minted by asserting `credentialId`. */
  async function deleteToken(h: ReturnType<typeof makeApp>, accountId: string, credId: string) {
    await h.svc(h.auth.beginStepUpPasskey(accountId));
    const { stepUpToken } = await h.svc(
      h.auth.completeStepUpPasskey(accountId, fakeAssertion(credId), "passkey_delete"),
    );
    return stepUpToken;
  }

  it("DELETE /passkeys/:id refuses the older target and permits the asserter itself", async () => {
    // Goes red on passing anything but `params.id` as the target — including
    // dropping the argument, which makes the target `null` and the rule inert.
    const h = makeApp();
    const acct = await recoveredAccount(h, "rt-del@example.com", "rtdel");

    const refused = await h.app.handle(
      json(`/passkeys/${acct.original.id}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${acct.accessToken}`,
          "x-step-up-token": await deleteToken(h, acct.profile.accountId, acct.fresh.credentialId),
        },
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_request" });

    // Same account, same kind of token, only the id differs.
    const permitted = await h.app.handle(
      json(`/passkeys/${acct.fresh.id}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${acct.accessToken}`,
          "x-step-up-token": await deleteToken(h, acct.profile.accountId, acct.fresh.credentialId),
        },
      }),
    );
    expect(permitted.status).toBe(200);
  });

  it("PATCH /passkeys/:id carries the same gate", async () => {
    // Rename shares the purpose claim and the comparison. Goes red on dropping
    // `params.id` from the rename route's verifier call.
    const h = makeApp();
    const acct = await recoveredAccount(h, "rt-ren@example.com", "rtren");

    const refused = await h.app.handle(
      json(`/passkeys/${acct.original.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${acct.accessToken}` },
        body: JSON.stringify({
          label: "renamed",
          step_up_token: await deleteToken(h, acct.profile.accountId, acct.fresh.credentialId),
        }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_request" });

    const permitted = await h.app.handle(
      json(`/passkeys/${acct.fresh.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${acct.accessToken}` },
        body: JSON.stringify({
          label: "renamed",
          step_up_token: await deleteToken(h, acct.profile.accountId, acct.fresh.credentialId),
        }),
      }),
    );
    expect(permitted.status).toBe(200);
  });

  it("POST /account/email/complete refuses an otp step-up inside the window", async () => {
    // The recovery window's other arm, through the route that matters most:
    // an email change is the pivot to a takeover the mailbox no longer bounds.
    // Goes red on the route calling a verifier that skips the cooldown.
    const h = makeApp();
    const acct = await recoveredAccount(h, "rt-ec@example.com", "rtec");

    const emailChangeCode = async (): Promise<string> => {
      const before = h.recorded().filter((r) => r.template === "otp-email-change").length;
      const begun = await h.app.handle(
        json("/account/email/begin", {
          method: "POST",
          headers: { authorization: `Bearer ${acct.accessToken}` },
          body: JSON.stringify({ new_email: "rt-ec-new@example.com" }),
        }),
      );
      expect(begun.status).toBe(200);
      const sent = h.recorded().filter((r) => r.template === "otp-email-change");
      expect(sent).toHaveLength(before + 1);
      return codeOf(sent.at(-1)!.text);
    };

    const complete = async (code: string) =>
      h.app.handle(
        json("/account/email/complete", {
          method: "POST",
          headers: { authorization: `Bearer ${acct.accessToken}` },
          body: JSON.stringify({
            code,
            step_up_token: await h.svc(
              h.auth.issueStepUpToken(acct.profile.accountId, "otp", "email_change"),
            ),
          }),
        }),
      );

    const refused = await complete(await emailChangeCode());
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_request" });

    // Age the recovery out and repeat: the same request now goes through, so
    // the 400 above was the window and not a bad code.
    await h.svc(
      Effect.promise(() =>
        h.db
          .update(accounts)
          .set({ lastRecoveredAt: Math.floor((Date.now() - RECOVERY_COOLDOWN_MS - 60_000) / 1000) })
          .where(eq(accounts.id, acct.profile.accountId)),
      ),
    );
    const permitted = await complete(await emailChangeCode());
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toEqual({ email: "rt-ec-new@example.com" });
  });
});

/**
 * What the disown does when the database says no.
 *
 * This is the branch that shipped wrong once and could not be seen from
 * anywhere: both database calls behind `POST /recovery/disown` swallowed their
 * errors, the return value was computed from an in-memory read taken before the
 * write, and so a transient outage spent the token, revoked nothing, answered
 * "accepted", and recorded a successful revocation on the one counter whose
 * whole purpose is to tell a real revocation from a no-op.
 *
 * The rule these tests hold is that the two are distinguishable — a caller can
 * see it, and an operator can see it — and that a click which failed can be
 * repeated.
 */
describe("POST /recovery/disown — when the write fails", () => {
  type FailMode = "none" | "select" | "write";

  /**
   * A rejected promise that answers every Drizzle chaining method with itself.
   * Building the statement stays synchronous, exactly as production does; the
   * failure lands where a real driver's would, on the await — which matters,
   * because a statement built into the batch array is constructed outside the
   * `Effect.tryPromise` that has to turn it into a `DatabaseError`.
   */
  const rejecting = (): never => {
    const promise = Promise.reject(new Error("d1 unavailable"));
    // Attaching a handler marks it handled, so a builder that is constructed
    // and then not awaited cannot raise an unhandled rejection. `await` still
    // rejects.
    void promise.catch(() => undefined);
    const chain = promise as unknown as Record<string, unknown>;
    for (const method of ["from", "where", "limit", "values", "set"]) {
      chain[method] = () => chain;
    }
    return chain as never;
  };

  /**
   * Fault injection with a budget, and the budget is the point.
   *
   * `remaining: 1` fails exactly ONE operation and lets every later one
   * through, which is what a transient outage looks like and — more
   * importantly — what makes a swallowed error visible. Failing every read
   * instead would let a second unguarded read produce the same 500 as the
   * first, and the test would then pass with the swallow on the first one put
   * back.
   */
  interface Brittle {
    mode: FailMode;
    remaining: number;
  }

  const brittle =
    (state: Brittle) =>
    (db: TestDb): TestDb =>
      new Proxy(db, {
        get(target, prop, receiver) {
          const armed = state.remaining > 0;
          // The first read `revokeDisownedRecovery` makes: the account's
          // credentials, the list the revocable set is computed from.
          if (armed && prop === "select" && state.mode === "select") {
            state.remaining -= 1;
            return () => rejecting();
          }
          // The audit-row insert, third of the four batched statements — so the
          // `last_recovered_at` clear behind it never runs.
          if (armed && prop === "insert" && state.mode === "write") {
            state.remaining -= 1;
            return () => rejecting();
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });

  async function recoverAndEnrol(h: ReturnType<typeof makeApp>, email: string, handle: string) {
    const profile = await h.svc(h.auth.registerProfile(email, handle));
    await h.svc(h.auth.beginPasskeyRegistration(profile.accountId));
    await h.svc(h.auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null));

    const code = await requestCode(h.app, h.recorded, email);
    const done = await post(h.app, "/login/recovery/email/complete", { identifier: email, code });
    const body = (await done.json()) as { session: { access_token: string } };
    await h.app.handle(
      json("/passkey/register/begin", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id }),
      }),
    );
    await h.app.handle(
      json("/passkey/register/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${body.session.access_token}` },
        body: JSON.stringify({ profileId: profile.id, attestation: {} }),
      }),
    );
    return { profile, token: await disownTokenFrom(h.recorded) };
  }

  const stateOf = (h: ReturnType<typeof makeApp>, accountId: string) =>
    h.svc(
      Effect.gen(function* () {
        const pks = yield* Effect.promise(() =>
          h.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.accountId, accountId)),
        );
        const live = yield* Effect.promise(() =>
          h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
        );
        const [row] = yield* Effect.promise(() =>
          h.db
            .select({ lastRecoveredAt: accounts.lastRecoveredAt })
            .from(accounts)
            .where(eq(accounts.id, accountId)),
        );
        return { passkeys: pks.length, sessions: live.length, window: row!.lastRecoveredAt };
      }),
    );

  it("a failed READ answers 500, records revoke_failed, and changes nothing", async () => {
    // Goes red on restoring the `Effect.catch(() => Effect.succeed([]))` on the
    // credential read, which turns an outage into "this account has no
    // credentials to revoke" and then reports that as an accepted disown.
    const fault: Brittle = { mode: "none", remaining: 0 };
    const h = makeApp({}, brittle(fault));
    const { profile, token } = await recoverAndEnrol(h, "fail-read@example.com", "failread");
    const before = await stateOf(h, profile.accountId);
    expect(before.passkeys).toBe(2);
    expect(before.window).not.toBeNull();

    fault.mode = "select";
    fault.remaining = 1;
    const mark = disownOutcomes.length;
    const res = await post(h.app, "/recovery/disown", { token });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(disownOutcomes.slice(mark)).toEqual(["revoke_failed"]);
    expect(await stateOf(h, profile.accountId)).toEqual(before);

    // The token is put back, so the owner's second click is the one that works.
    // Without the re-park a transient blip destroys the lever for good.
    fault.mode = "none";
    const retry = await post(h.app, "/recovery/disown", { token });
    expect(retry.status).toBe(202);
    expect(disownOutcomes.slice(mark)).toEqual(["revoke_failed", "accepted"]);
    const after = await stateOf(h, profile.accountId);
    expect(after).toEqual({ passkeys: 1, sessions: 0, window: null });
  });

  it("a failed WRITE answers 500, records revoke_failed, and leaves the window open", async () => {
    // Goes red on restoring the `Effect.catch(logWarning)` around the
    // `commitBatch`: the batch fails, the metric says `accepted`, and the route
    // tells the account owner their recovery has been disowned.
    const fault: Brittle = { mode: "none", remaining: 0 };
    const h = makeApp({}, brittle(fault));
    const { profile, token } = await recoverAndEnrol(h, "fail-write@example.com", "failwrite");

    fault.mode = "write";
    fault.remaining = 1;
    const mark = disownOutcomes.length;
    const res = await post(h.app, "/recovery/disown", { token });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(disownOutcomes.slice(mark)).toEqual(["revoke_failed"]);
    // The clear is the last statement of the four, so a batch that failed
    // before it must leave the window standing.
    expect((await stateOf(h, profile.accountId)).window).not.toBeNull();

    fault.mode = "none";
    expect((await post(h.app, "/recovery/disown", { token })).status).toBe(202);
    expect(disownOutcomes.slice(mark)).toEqual(["revoke_failed", "accepted"]);
    expect((await stateOf(h, profile.accountId)).window).toBeNull();
  });
});
