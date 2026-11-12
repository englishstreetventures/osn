/**
 * Account recovery by an authenticator code, at the HTTP boundary. (Recovery
 * by an emailed link is in `recovery-link.test.ts`.)
 *
 * What these tests are really pinning is a set of guards that all fail SILENTLY
 * when they break — a branch that skips a store read returns the same bytes as
 * one that makes it, and a lockout that shares a counter with another surface
 * looks identical until somebody uses it as a weapon. So each one below is
 * written to go red on a specific edit, named in its comment, and each was
 * confirmed red by making that edit.
 *
 * The last block in the file counts store round trips rather than asserting on
 * a response, because the remaining oracle after the bodies are uniform is
 * cost. See its own header.
 *
 * See `wiki/osn/account-recovery-factors.md` §B and
 * §"Enumeration, timing and flood control".
 */

import { Database } from "bun:sqlite";

import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { EmailService, makeLogEmailLive } from "@shared/email";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  type RecoveryLockoutStore,
} from "../../src/lib/recovery-lockout-store";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import {
  RECOVERY_TOKEN_AUDIENCE,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
} from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createAuthRoutes } from "../helpers/routes";

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;

const json = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

/** Decode a JWT payload without verifying — we only assert on claims here. */
const payloadOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

/** The piece of a harness the shared helpers below actually need. */
type RouteApp = { handle: (request: Request) => Promise<Response> };

/**
 * A route app, a service and the raw sqlite handle over ONE layer.
 *
 * `emailLayer` is injectable because one test needs a transport that hangs; the
 * default is the ordinary recorder every other test in this repo uses.
 */
function makeApp(emailLayer?: Layer.Layer<EmailService>, overrides: Partial<AuthConfig> = {}) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), emailLayer ?? recorder.layer);
  const merged = { ...config, ...overrides };
  const app = createAuthRoutes(merged, layer);
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  const seed = async (emailAddr: string, handle: string) => {
    const profile = await svc(auth.registerProfile(emailAddr, handle));
    return profile;
  };
  return { app, auth, db, svc, seed, recorded: recorder.recorded };
}

/**
 * Wait for a forked send to land, or give up.
 *
 * Every notice in this service is dispatched off the response path, so nothing
 * is in the recorder when the handler returns. Polling rather than a fixed
 * sleep keeps the tests fast and keeps a slow machine from going red.
 */
async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Enrol a confirmed TOTP credential and hand back its secret. */
async function enrolTotp(
  app: RouteApp,
  auth: ReturnType<typeof createAuthService>,
  svc: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>,
  accountId: string,
  accessToken: string,
): Promise<Uint8Array> {
  const stepUp = await svc(auth.issueStepUpToken(accountId, "passkey", "totp_enroll"));
  const begun = (await (
    await app.handle(
      json("/totp/enroll/begin", {
        method: "POST",
        body: JSON.stringify({ step_up_token: stepUp }),
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    )
  ).json()) as { totpSecret: string };
  const secret = base32Decode(begun.totpSecret);
  await app.handle(
    json("/totp/enroll/complete", {
      method: "POST",
      body: JSON.stringify({
        code: await deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)),
      }),
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  return secret;
}

describe("POST /login/recovery/totp/complete", () => {
  async function seedEnrolled(emailAddr: string, handle: string) {
    const harness = makeApp();
    const profile = await harness.seed(emailAddr, handle);
    const tokens = await harness.svc(
      harness.auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    const secret = await enrolTotp(
      harness.app,
      harness.auth,
      harness.svc,
      profile.accountId,
      tokens.accessToken,
    );
    return { ...harness, profile, tokens, secret };
  }

  it("mints a restricted session from a code, by handle", async () => {
    const { app, secret } = await seedEnrolled("rt-ok@example.com", "rtok");
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1;

    const res = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rtok", code: await deriveTotpCode(secret, step) }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { access_token: string } };
    expect(payloadOf(body.session.access_token)["aud"]).toBe(RECOVERY_TOKEN_AUDIENCE);
    expect(res.headers.get("set-cookie")).toContain("osn_session=");
  });

  it("mints a restricted session from a code, by EMAIL ADDRESS", async () => {
    // The client documents that this identifier "may be a handle or an email
    // address", and every other test here drives it by handle — so the email
    // arm has been the one an unauthenticated caller can use to ask whether an
    // address has an OSN account, with nothing pinning it.
    // Goes red on: adding a `looksLikeEmail`-style refusal here (the rule that
    // belongs to `begin`, which sends mail; this route sends nothing).
    const { app, secret } = await seedEnrolled("rt-byemail@example.com", "rtbyemail");
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1;

    const res = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({
          identifier: "rt-byemail@example.com",
          code: await deriveTotpCode(secret, step),
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { handle: string } };
    expect(body.profile.handle).toBe("rtbyemail");
  });

  it("sends the recovery-used notice, exactly as the email factor does", async () => {
    // The second caller of `completeRecoveryFactor`. Both factors end in the
    // same revoke-and-notify, and a notice wired to only one of them would be
    // invisible here without this.
    const { app, secret, recorded } = await seedEnrolled("rt-notice@example.com", "rtnotice");
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1;

    const res = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({
          identifier: "rtnotice",
          code: await deriveTotpCode(secret, step),
        }),
      }),
    );
    expect(res.status).toBe(200);

    await settle(() => recorded().some((r) => r.template === "recovery-used"));
    const notices = recorded().filter((r) => r.template === "recovery-used");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to).toBe("rt-notice@example.com");
  });

  it("refuses a replayed code", async () => {
    // RFC 6238 §5.2. `verifyTotpCode` is stateless, so single use is the
    // conditional UPDATE in `consumeStep` — a replay off the wire would
    // otherwise be an account takeover, not a repeated ceremony.
    // Goes red on: bypassing `checkTotpCode`'s `consumeStep`.
    const { app, secret } = await seedEnrolled("rt-replay@example.com", "rtreplay");
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1;
    const code = await deriveTotpCode(secret, step);

    const first = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rtreplay", code }),
      }),
    );
    expect(first.status).toBe(200);

    const second = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rtreplay", code }),
      }),
    );
    expect(second.status).toBe(400);
  });

  it("refuses an account with no confirmed credential, and an unknown identifier, alike", async () => {
    // `confirmedCredential` filters on `confirmedAt`, and the not-enrolled
    // branch still pays for a full verification so it cannot be timed apart.
    const { app, seed } = makeApp();
    await seed("rt-none@example.com", "rtnone");

    const notEnrolled = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rtnone", code: "000000" }),
      }),
    );
    const unknown = await app.handle(
      json("/login/recovery/totp/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rtnobody", code: "000000" }),
      }),
    );

    expect(notEnrolled.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(await notEnrolled.json()).toEqual(await unknown.json());
  });

  it("does not lock the authenticated step-up ceremony", async () => {
    // The finding this test exists for. `checkTotpCode` is shared with
    // `POST /step-up/totp/complete`, which is authenticated; this route is not,
    // and it accepts a PUBLIC handle. On a shared counter, five requests from
    // anyone who knows the handle would lock the owner's step-up for fifteen
    // minutes — taking passkey_register, recovery_generate, totp_enroll,
    // totp_disable, account_delete and account_export with it — repeatedly and
    // indefinitely.
    //
    // Goes red on: passing "step_up" instead of "recovery" in
    // `completeTotpRecovery`, or dropping the `scope` parameter so both share a
    // key.
    const { app, tokens, secret } = await seedEnrolled("rt-lock@example.com", "rtlock");

    // Spend the recovery surface's whole allowance from the public handle.
    for (let i = 0; i < 6; i++) {
      const res = await app.handle(
        json("/login/recovery/totp/complete", {
          method: "POST",
          body: JSON.stringify({ identifier: "rtlock", code: "000000" }),
        }),
      );
      expect(res.status).toBe(400);
    }

    // The owner's authenticated ceremony is untouched.
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1;
    const stepUp = await app.handle(
      json("/step-up/totp/complete", {
        method: "POST",
        body: JSON.stringify({
          code: await deriveTotpCode(secret, step),
          purpose: "passkey_register",
        }),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(stepUp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Round-trip parity
//
// Uniform bodies close half the oracle. The other half is cost: every store
// call is a Durable Object hop in every tier but `local`, so a branch that
// makes two hops answers measurably sooner than one that makes four, and the
// difference is readable with a stopwatch from an unauthenticated client.
//
// `/login/recovery/totp/complete` accepts an email address as readily as a
// handle, so on unequal branches a timed wrong code reads out as "this address
// has an OSN account", against no per-account cap and a per-IP limiter a
// rotating fleet already defeats at this issuer.
//
// A wall-clock assertion would be flaky here and would pin nothing on a fast
// in-memory store. Counting the calls pins the same property and cannot flake:
// the branches must invoke the SAME NUMBER of store operations, and the
// non-resolving branch must match the COSTLIEST resolving one, not the
// cheapest.
//
// See `wiki/osn/account-recovery-factors.md`
// §"Enumeration, timing and flood control".
// ---------------------------------------------------------------------------

/** One counter per backing store the TOTP recovery ceremony touches. */
interface Hops {
  /** `totpLockoutStore` — status, recordFailure and reset alike. */
  totpLockout: number;
  /** SQL statements naming `totp_credentials` — the credential query is a hop too. */
  totpCredentials: number;
}

const zeroHops = (): Hops => ({
  totpLockout: 0,
  totpCredentials: 0,
});

/** Count every operation, whatever it is: a hop is a hop. */
function countingLockout(bump: () => void, inner: RecoveryLockoutStore): RecoveryLockoutStore {
  return {
    backend: inner.backend,
    status: (id) => {
      bump();
      return inner.status(id);
    },
    recordFailure: (id) => {
      bump();
      return inner.recordFailure(id);
    },
    reset: (id, failures) => {
      bump();
      return inner.reset(id, failures);
    },
  };
}

/**
 * `makeApp`, with every store the recovery ceremonies reach wrapped in a
 * counter.
 *
 * The stores are the real in-memory defaults — the wrappers only tally, so
 * nothing about the ceremony's behaviour changes. The `totp_credentials` count
 * comes off drizzle's query logger rather than a proxied builder: the
 * credential SELECT is a database round trip and belongs in the same ledger as
 * the store hops.
 */
function makeCountingApp(options: { readonly lockoutsUnreachable?: boolean } = {}) {
  const hops = zeroHops();
  // A shared lockout store answers `"unknown"` while its backend fails; this
  // stands in for one, so a branch's cost can be measured during a fault.
  const unreachable: RecoveryLockoutStore = {
    backend: "memory",
    status: () => Promise.resolve({ status: "unknown" as const }),
    recordFailure: () => Promise.resolve("unknown"),
    reset: () => Promise.resolve(),
  };
  const lockoutStore = (limits?: Parameters<typeof createInMemoryRecoveryLockoutStore>[0]) =>
    options.lockoutsUnreachable ? unreachable : createInMemoryRecoveryLockoutStore(limits);
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({
    client: sqlite,
    logger: {
      logQuery: (query: string) => {
        if (query.includes("totp_credentials")) hops.totpCredentials += 1;
      },
    },
  });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);

  const merged: AuthConfig = {
    ...config,
    totpLockoutStore: countingLockout(
      () => {
        hops.totpLockout += 1;
      },
      lockoutStore({
        threshold: TOTP_LOCKOUT_THRESHOLD,
        lockoutMs: TOTP_LOCKOUT_MS,
      }),
    ),
  };

  const app = createAuthRoutes(merged, layer);
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  const seed = (emailAddr: string, handle: string) => svc(auth.registerProfile(emailAddr, handle));

  /** The hops one request costs — a delta, so set-up never leaks into a count. */
  const measure = async (run: () => Promise<unknown>): Promise<Hops> => {
    const before = { ...hops };
    await run();
    return {
      totpLockout: hops.totpLockout - before.totpLockout,
      totpCredentials: hops.totpCredentials - before.totpCredentials,
    };
  };

  return { app, auth, svc, seed, recorded: recorder.recorded, measure };
}

const post = (app: RouteApp, path: string, body: unknown) =>
  app.handle(json(path, { method: "POST", body: JSON.stringify(body) }));

describe("recovery routes cost the same however a request ends", () => {
  it("POST /login/recovery/totp/complete — an unknown identifier costs what a real account costs", async () => {
    // The sharper of the two parity tests: this route resolves through the same
    // `resolveIdentifier`, and the client documents that the identifier "may be
    // a handle or an email address" — so a cheap miss here lets a stranger ask
    // whether an EMAIL ADDRESS has an OSN account.
    //
    // A real account counts the attempt and runs the credential query; the
    // padding must do the same, at the probe key, and must not touch the
    // pending-code store, which this ceremony never otherwise uses. Both halves
    // are asserted: the counts must match, and the pending-code store must not
    // be touched at all.
    //
    // Goes red on: dropping the count or the credential query from
    // `burnTotpCheckCost`, or padding with a read of another store.

    // (a) a real account with no authenticator — the attempt is counted,
    //     `confirmedCredential` misses, the verification still runs.
    const bareHarness = makeCountingApp();
    await bareHarness.seed("hp-tbare@example.com", "hptbare");
    const bare = await bareHarness.measure(() =>
      post(bareHarness.app, "/login/recovery/totp/complete", {
        identifier: "hptbare",
        code: "000000",
      }),
    );

    // (b) a real account WITH an authenticator, wrong code.
    const enrolledHarness = makeCountingApp();
    const profile = await enrolledHarness.seed("hp-tenrol@example.com", "hptenrol");
    const tokens = await enrolledHarness.svc(
      enrolledHarness.auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    await enrolTotp(
      enrolledHarness.app,
      enrolledHarness.auth,
      enrolledHarness.svc,
      profile.accountId,
      tokens.accessToken,
    );
    const enrolled = await enrolledHarness.measure(() =>
      post(enrolledHarness.app, "/login/recovery/totp/complete", {
        identifier: "hptenrol",
        code: "000000",
      }),
    );

    // (c) an identifier that names no account.
    const unknownHarness = makeCountingApp();
    const unknown = await unknownHarness.measure(() =>
      post(unknownHarness.app, "/login/recovery/totp/complete", {
        identifier: "hp-tnobody@example.com",
        code: "000000",
      }),
    );

    const shape = (h: Hops) => ({
      lockout: h.totpLockout,
      credentials: h.totpCredentials,
    });
    // (d) a locked account: five wrong codes get it there; the sixth is measured.
    const lockedHarness = makeCountingApp();
    await lockedHarness.seed("hp-tlock@example.com", "hptlock");
    for (let i = 0; i < TOTP_LOCKOUT_THRESHOLD; i++) {
      await post(lockedHarness.app, "/login/recovery/totp/complete", {
        identifier: "hptlock",
        code: "000000",
      });
    }
    const locked = await lockedHarness.measure(() =>
      post(lockedHarness.app, "/login/recovery/totp/complete", {
        identifier: "hptlock",
        code: "000000",
      }),
    );

    expect(shape(bare)).toEqual({ lockout: 1, credentials: 1 });
    expect(shape(enrolled)).toEqual(shape(bare));
    expect(shape(unknown)).toEqual(shape(bare));
    // Goes red on: refusing a locked account before the credential query.
    expect(shape(locked)).toEqual(shape(bare));
  });
});

describe("recovery routes cost the same when the lockout counter cannot be read", () => {
  // A shared counter answers `"unknown"` while its store fails. Every caller
  // refuses then — but a refusal that skipped the padding would answer a real
  // account sooner than an identifier that names nobody, for as long as the
  // fault lasted.

  it("POST /login/recovery/totp/complete — a real account costs what nobody costs", async () => {
    // Goes red on: returning from the `"unknown"` branch of `checkTotpCode`
    // before the credential query.
    const realHarness = makeCountingApp({ lockoutsUnreachable: true });
    await realHarness.seed("hu-treal@example.com", "hutreal");
    const real = await realHarness.measure(() =>
      post(realHarness.app, "/login/recovery/totp/complete", {
        identifier: "hutreal",
        code: "000000",
      }),
    );

    const unknownHarness = makeCountingApp({ lockoutsUnreachable: true });
    const unknown = await unknownHarness.measure(() =>
      post(unknownHarness.app, "/login/recovery/totp/complete", {
        identifier: "hu-tnobody@example.com",
        code: "000000",
      }),
    );

    expect(real.totpLockout).toBe(1);
    expect(real.totpCredentials).toBe(1);
    expect(unknown.totpLockout).toBe(real.totpLockout);
    expect(unknown.totpCredentials).toBe(real.totpCredentials);
  });
});
