/**
 * The three unauthenticated account-recovery routes, at the HTTP boundary.
 *
 * What these tests are really pinning is a set of guards that all fail SILENTLY
 * when they break — a uniform 202 still looks uniform when the send is awaited,
 * a cap still returns 202 when it has been removed, a branch that skips a store
 * read returns the same bytes as one that makes it, and a lockout that shares a
 * counter with another surface looks identical until somebody uses it as a
 * weapon. So each one below is written to go red on a specific edit, named in
 * its comment, and each was confirmed red by making that edit.
 *
 * The last block in the file counts store round trips rather than asserting on
 * a response, because the remaining oracle after the bodies are uniform is
 * cost. See its own header.
 *
 * See `wiki/architecture/account-recovery-factors.md` §B and
 * §"Enumeration, timing and flood control".
 */

import { Database } from "bun:sqlite";

import { sessions, securityEvents } from "@osn/db/schema";
import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import {
  EmailService,
  makeLogEmailLive,
  type RecordedEmail,
  type SendEmailInput,
} from "@shared/email";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  type RecoveryLockoutStore,
} from "../../src/lib/recovery-lockout-store";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import {
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  RECOVERY_TOKEN_AUDIENCE,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
} from "../../src/services/auth/constants";
import {
  createDefaultCeremonyStores,
  createInMemoryAccountCap,
} from "../../src/services/auth/stores";
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

/** The two pieces of a harness the shared helpers below actually need. */
type RouteApp = { handle: (request: Request) => Promise<Response> };
type Recorder = () => readonly RecordedEmail[];

/**
 * A route app, a service and the raw sqlite handle over ONE layer.
 *
 * `emailLayer` is injectable because one test needs a transport that hangs; the
 * default is the ordinary recorder every other test in this repo uses.
 */
function makeApp(emailLayer?: Layer.Layer<EmailService>, overrides: Partial<AuthConfig> = {}) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
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

/** Pull the 6-digit code out of a rendered recovery email. */
const codeOf = (text: string): string => {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match) throw new Error("no 6-digit code in the recorded email");
  return match[1]!;
};

/** Every recovery code the recorder has captured so far, oldest first. */
const codesSoFar = (recorded: readonly { template: string; text: string }[]): string[] =>
  recorded.filter((r) => r.template === "otp-recovery").map((r) => codeOf(r.text));

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

/**
 * Drive `begin` and return the code it sent.
 *
 * Waits for the recorder's recovery-mail COUNT to grow, not merely for one to
 * exist: the entry is keyed by account, so a second `begin` replaces the first
 * code, and a helper that stopped at "some mail has arrived" would hand back the
 * superseded one. That is a helper bug that shows up as a confusing 400 in a
 * test about something else entirely.
 */
async function requestCode(app: RouteApp, recorded: Recorder, identifier: string): Promise<string> {
  const before = codesSoFar(recorded()).length;
  const res = await app.handle(
    json("/login/recovery/email/begin", {
      method: "POST",
      body: JSON.stringify({ identifier }),
    }),
  );
  expect(res.status).toBe(202);
  // The send is detached, so the fibre has usually not run by the time the
  // response resolves — which is the property the suite above pins.
  for (let i = 0; i < 100 && codesSoFar(recorded()).length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const codes = codesSoFar(recorded());
  expect(codes.length).toBe(before + 1);
  return codes.at(-1)!;
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

describe("POST /login/recovery/email/begin", () => {
  it("answers an identical 202 whether or not the identifier resolves", async () => {
    const { app, seed } = makeApp();
    await seed("rb-known@example.com", "rbknown");

    const known = await app.handle(
      json("/login/recovery/email/begin", {
        method: "POST",
        body: JSON.stringify({ identifier: "rb-known@example.com" }),
      }),
    );
    const unknown = await app.handle(
      json("/login/recovery/email/begin", {
        method: "POST",
        body: JSON.stringify({ identifier: "rb-nobody@example.com" }),
      }),
    );

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual({ status: "accepted" });
    expect(await unknown.json()).toEqual({ status: "accepted" });
    // Nothing else may differ either — a stray header is an oracle too.
    expect(known.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });

  it(
    "does not await the mail send, and still sends it",
    // SHORTER than the forked send's own 10-second `Effect.timeout`, so an
    // awaited implementation fails HERE rather than passing slowly if vitest's
    // 5-second default is ever raised.
    { timeout: 4000 },
    async () => {
      // THE oracle this endpoint exists to close. Every other OTP send in this
      // service awaits the provider; a Resend round trip is hundreds of
      // milliseconds against a sub-millisecond database probe, so awaiting here
      // would separate a resolving identifier from a non-resolving one however
      // uniform the body is.
      //
      // Goes red on: replacing `Effect.forkDetach` with a direct `yield*` — the
      // handler then blocks on `gate` and this test times out. The explicit
      // `testTimeout` below is load-bearing: it is SHORTER than the 10-second
      // `Effect.timeout` on the forked send, so an awaited implementation fails
      // here rather than passing slowly if somebody raises vitest's default.
      //
      // The second assertion is what stops a fibre that is never scheduled (or
      // is cancelled) from passing identically to one that works.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: SendEmailInput[] = [];
      const hangingEmail = Layer.succeed(EmailService, {
        send: (input: SendEmailInput) =>
          Effect.promise(async () => {
            await gate;
            sent.push(input);
          }),
      });

      const { app, seed } = makeApp(hangingEmail);
      await seed("rb-hang@example.com", "rbhang");

      const res = await app.handle(
        json("/login/recovery/email/begin", {
          method: "POST",
          body: JSON.stringify({ identifier: "rb-hang@example.com" }),
        }),
      );
      // Returned while the transport is still parked.
      expect(res.status).toBe(202);
      expect(sent).toHaveLength(0);

      release();
      for (let i = 0; i < 100 && sent.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]!.template).toBe("otp-recovery");
      expect(sent[0]!.to).toBe("rb-hang@example.com");
    },
  );

  it("refuses a handle", async () => {
    // A handle is public. `/login/passkey/begin` may take one because it sends
    // nothing; this endpoint puts mail in an inbox, so accepting one would turn
    // a public identifier into a way to mail a stranger.
    // Goes red on: dropping the `looksLikeEmail` guard (the handle then
    // resolves and the route answers 202).
    const { app, seed, recorded } = makeApp();
    await seed("rb-handle@example.com", "rbhandle");

    const res = await app.handle(
      json("/login/recovery/email/begin", {
        method: "POST",
        body: JSON.stringify({ identifier: "rbhandle" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorded().filter((r) => r.template === "otp-recovery")).toHaveLength(0);
  });

  it("caps the fourth send in 24h, still answers 202, and does not burn the pending code", async () => {
    // The recipient is the victim: an uncapped endpoint floods the account
    // holder's inbox and trains them to expect recovery mail. Per-IP limiting
    // does not reach it — a rotating fleet defeats per-IP keys.
    //
    // Goes red on: removing the cap check (a fourth email is recorded), or
    // moving the store write above the cap check (the third code stops working
    // — which is the denial-of-service the cap would otherwise become).
    const { app, seed, recorded } = makeApp();
    await seed("rb-cap@example.com", "rbcap");

    await requestCode(app, recorded, "rb-cap@example.com");
    await requestCode(app, recorded, "rb-cap@example.com");
    const third = await requestCode(app, recorded, "rb-cap@example.com");

    const fourth = await app.handle(
      json("/login/recovery/email/begin", {
        method: "POST",
        body: JSON.stringify({ identifier: "rb-cap@example.com" }),
      }),
    );
    expect(fourth.status).toBe(202);
    expect(await fourth.json()).toEqual({ status: "accepted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorded().filter((r) => r.template === "otp-recovery")).toHaveLength(3);

    // The capped call must not have replaced the code the user is holding.
    const completed = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rb-cap@example.com", code: third }),
      }),
    );
    expect(completed.status).toBe(200);
  });
});

describe("POST /login/recovery/email/complete", () => {
  it("issues a restricted recovery session and sets the session cookie", async () => {
    const { app, seed, recorded } = makeApp();
    await seed("rc-ok@example.com", "rcok");
    const code = await requestCode(app, recorded, "rc-ok@example.com");

    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-ok@example.com", code }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { access_token: string };
      profile: { handle: string };
    };
    expect(body.profile.handle).toBe("rcok");
    // The audience is the whole restriction: every verifier in this service and
    // the three downstream services pin `osn-access` and so reject this.
    // Goes red on: passing `false` for `restricted` in `issueSession`.
    expect(payloadOf(body.session.access_token)["aud"]).toBe(RECOVERY_TOKEN_AUDIENCE);
    // Goes red on: dropping `buildSessionCookies` — without the cookie
    // `completePasskeyRegistration` answers 409 `session_stale` at the one step
    // this session exists to perform.
    expect(res.headers.get("set-cookie")).toContain("osn_session=");
    // The refresh token stays in the cookie and never in the body.
    expect(Object.keys(body.session).toSorted()).toEqual([
      "access_token",
      "expires_in",
      "scope",
      "token_type",
    ]);
  });

  it("revokes every other session and writes account_recovered", async () => {
    // Matches `consumeRecoveryCode`: a second recovery ceremony that revoked
    // less, or recorded less, would be a quieter way into the same account.
    // Goes red on: dropping the `delete(sessions)` from the batch, or writing
    // the security event outside it.
    const { app, auth, db, svc, seed, recorded } = makeApp();
    const profile = await seed("rc-wipe@example.com", "rcwipe");
    await svc(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    const before = await db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, profile.accountId));
    expect(before).toHaveLength(1);

    const code = await requestCode(app, recorded, "rc-wipe@example.com");
    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-wipe@example.com", code }),
      }),
    );
    expect(res.status).toBe(200);

    // Exactly one session survives: the restricted one just issued.
    const after = await db.select().from(sessions).where(eq(sessions.accountId, profile.accountId));
    expect(after).toHaveLength(1);
    expect(after[0]!.restrictedUntil).not.toBeNull();
    expect(after[0]!.id).not.toBe(before[0]!.id);

    const events = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.accountId, profile.accountId));
    expect(events.map((e) => e.kind)).toContain("account_recovered");
  });

  it("sends the recovery-used notice to the address on the account", async () => {
    // The only channel that reaches a user whose sessions have just been
    // revoked by somebody else. It is forked off the response path, so a wrong
    // template name or a `kind`↔`template` pairing that does not match passes
    // every other test in this file silently.
    //
    // Both halves are asserted together because they are one decision:
    // `notifySecurityEventByAccountId` takes the kind AND the template, and
    // nothing else pins that they agree.
    //
    // Goes red on: naming any other template at the `forkBackground` call in
    // `completeRecoveryFactor`, or dropping the fork.
    const { app, db, seed, recorded } = makeApp();
    const profile = await seed("rc-notice@example.com", "rcnotice");
    const code = await requestCode(app, recorded, "rc-notice@example.com");

    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-notice@example.com", code }),
      }),
    );
    expect(res.status).toBe(200);

    await settle(() => recorded().some((r) => r.template === "recovery-used"));
    const notices = recorded().filter((r) => r.template === "recovery-used");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to).toBe("rc-notice@example.com");

    const events = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.accountId, profile.accountId));
    expect(events.map((e) => e.kind)).toContain("account_recovered");
  });

  it("burns the pending entry after MAX_OTP_ATTEMPTS wrong codes, lockout aside", async () => {
    // `MAX_OTP_ATTEMPTS` and `RECOVERY_LOCKOUT_THRESHOLD` are both 5, so on a
    // stock service the two fire on the SAME attempt and a test written the
    // obvious way passes whichever one is doing the work. Written that way this
    // test stayed green with the attempt bump deleted — the lockout was
    // refusing the final code.
    //
    // So the lockout is lifted out of the way (threshold 100) and the per-entry
    // cap is left as the only thing that can refuse the correct code.
    // Goes red on: dropping the attempt bump.
    const { app, seed, recorded } = makeApp(undefined, {
      recoveryOtpLockoutStore: createInMemoryRecoveryLockoutStore({ threshold: 100 }),
    });
    await seed("rc-att@example.com", "rcatt");
    const code = await requestCode(app, recorded, "rc-att@example.com");

    for (let i = 0; i < 5; i++) {
      const bad = await app.handle(
        json("/login/recovery/email/complete", {
          method: "POST",
          body: JSON.stringify({ identifier: "rc-att@example.com", code: "000000" }),
        }),
      );
      expect(bad.status).toBe(400);
    }

    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-att@example.com", code }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("does not count an attempt when no code is pending", async () => {
    // Counting it would hand anyone who knows the identifier a lever to lock the
    // owner out of their own recovery without ever guessing a digit.
    // Goes red on: moving `recordFailure` above the pending-entry check.
    const { app, seed, recorded } = makeApp();
    await seed("rc-nopend@example.com", "rcnopend");

    for (let i = 0; i < 6; i++) {
      const res = await app.handle(
        json("/login/recovery/email/complete", {
          method: "POST",
          body: JSON.stringify({ identifier: "rc-nopend@example.com", code: "000000" }),
        }),
      );
      expect(res.status).toBe(400);
    }

    // The counter never moved, so a code requested now still works.
    const code = await requestCode(app, recorded, "rc-nopend@example.com");
    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-nopend@example.com", code }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("locks the account out across a second code request", async () => {
    // What the lockout adds over the per-entry cap: they coincide on the FIRST
    // entry (both are 5), so the counter's real job is the second and third.
    // Without it the 3-per-24h send cap would still allow fifteen guesses.
    // Goes red on: dropping `recordFailure` or the `isLocked` gate.
    const { app, db, seed, recorded } = makeApp();
    const profile = await seed("rc-lock@example.com", "rclock");

    await requestCode(app, recorded, "rc-lock@example.com");
    for (let i = 0; i < 5; i++) {
      await app.handle(
        json("/login/recovery/email/complete", {
          method: "POST",
          body: JSON.stringify({ identifier: "rc-lock@example.com", code: "000000" }),
        }),
      );
    }

    // A fresh, genuinely correct code is refused while the lockout stands —
    // and with the same generic error, so "locked" is not its own oracle.
    const second = await requestCode(app, recorded, "rc-lock@example.com");
    const res = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-lock@example.com", code: second }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });

    const events = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.accountId, profile.accountId));
    expect(events.map((e) => e.kind)).toContain("recovery_otp_lockout");
  });

  it("answers a wrong code and an unknown identifier byte-identically", async () => {
    // `publicError` collapses every AuthError to the same envelope, so this is
    // mostly a guard against somebody adding a `message` to one branch — and
    // against either branch leaking a cookie.
    const { app, seed } = makeApp();
    await seed("rc-same@example.com", "rcsame");

    const wrongCode = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-same@example.com", code: "000000" }),
      }),
    );
    const unknown = await app.handle(
      json("/login/recovery/email/complete", {
        method: "POST",
        body: JSON.stringify({ identifier: "rc-nobody@example.com", code: "000000" }),
      }),
    );

    expect(wrongCode.status).toBe(unknown.status);
    expect(await wrongCode.json()).toEqual(await unknown.json());
    expect(wrongCode.headers.get("set-cookie")).toBeNull();
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });
});

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
// here is an HTTP hop to Upstash in every tier but `local`, so a branch that
// makes two hops answers measurably sooner than one that makes four, and the
// difference is readable with a stopwatch from an unauthenticated client.
//
// `begin` always answers 202 and parks a code only for an address that
// resolves — so the attack is two calls: `begin` for a candidate address, then
// `complete` with a wrong code, timed. On unequal branches that reads out as
// "this address has an OSN account", against no per-account cap and a per-IP
// limiter a rotating fleet already defeats at this issuer.
//
// A wall-clock assertion would be flaky here and would pin nothing on a fast
// in-memory store. Counting the calls pins the same property and cannot flake:
// the branches must invoke the SAME NUMBER of store operations, and the
// non-resolving branch must match the COSTLIEST resolving one, not the
// cheapest.
//
// See `wiki/architecture/account-recovery-factors.md`
// §"Enumeration, timing and flood control".
// ---------------------------------------------------------------------------

/** One counter per backing store the recovery ceremonies touch. */
interface Hops {
  /** `stores.pendingRecoveryOtp` — get, set and delete alike. */
  pendingRecoveryOtp: number;
  /** `recoveryOtpLockoutStore` — isLocked, recordFailure and reset alike. */
  recoveryOtpLockout: number;
  /** `totpLockoutStore`, same. */
  totpLockout: number;
  /** `recoveryEmailBeginCap.check`. */
  recoveryEmailBeginCap: number;
  /** SQL statements naming `totp_credentials` — the credential query is a hop too. */
  totpCredentials: number;
}

const zeroHops = (): Hops => ({
  pendingRecoveryOtp: 0,
  recoveryOtpLockout: 0,
  totpLockout: 0,
  recoveryEmailBeginCap: 0,
  totpCredentials: 0,
});

/** Count every operation, whatever it is: a hop is a hop. */
function countingLockout(bump: () => void, inner: RecoveryLockoutStore): RecoveryLockoutStore {
  return {
    backend: inner.backend,
    isLocked: (id) => {
      bump();
      return inner.isLocked(id);
    },
    recordFailure: (id) => {
      bump();
      return inner.recordFailure(id);
    },
    reset: (id) => {
      bump();
      return inner.reset(id);
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
function makeCountingApp() {
  const hops = zeroHops();
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle(sqlite, {
    schema,
    logger: {
      logQuery: (query: string) => {
        if (query.includes("totp_credentials")) hops.totpCredentials += 1;
      },
    },
  });
  const recorder = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), recorder.layer);

  const ceremonyStores = createDefaultCeremonyStores();
  const pending = ceremonyStores.pendingRecoveryOtp;
  const cap = createInMemoryAccountCap(
    RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
    RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  );

  const merged: AuthConfig = {
    ...config,
    ceremonyStores: {
      ...ceremonyStores,
      pendingRecoveryOtp: {
        backend: pending.backend,
        namespace: pending.namespace,
        get: (key) => {
          hops.pendingRecoveryOtp += 1;
          return pending.get(key);
        },
        set: (key, value, ttlMs) => {
          hops.pendingRecoveryOtp += 1;
          return pending.set(key, value, ttlMs);
        },
        delete: (key) => {
          hops.pendingRecoveryOtp += 1;
          return pending.delete(key);
        },
      },
    },
    recoveryOtpLockoutStore: countingLockout(() => {
      hops.recoveryOtpLockout += 1;
    }, createInMemoryRecoveryLockoutStore()),
    totpLockoutStore: countingLockout(
      () => {
        hops.totpLockout += 1;
      },
      createInMemoryRecoveryLockoutStore({
        threshold: TOTP_LOCKOUT_THRESHOLD,
        lockoutMs: TOTP_LOCKOUT_MS,
      }),
    ),
    recoveryEmailBeginCap: {
      check: (key) => {
        hops.recoveryEmailBeginCap += 1;
        return cap.check(key);
      },
    },
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
      pendingRecoveryOtp: hops.pendingRecoveryOtp - before.pendingRecoveryOtp,
      recoveryOtpLockout: hops.recoveryOtpLockout - before.recoveryOtpLockout,
      totpLockout: hops.totpLockout - before.totpLockout,
      recoveryEmailBeginCap: hops.recoveryEmailBeginCap - before.recoveryEmailBeginCap,
      totpCredentials: hops.totpCredentials - before.totpCredentials,
    };
  };

  return { app, auth, svc, seed, recorded: recorder.recorded, measure };
}

const post = (app: RouteApp, path: string, body: unknown) =>
  app.handle(json(path, { method: "POST", body: JSON.stringify(body) }));

describe("recovery routes cost the same however a request ends", () => {
  it("POST /login/recovery/email/begin — sent, capped and unknown all make two hops", async () => {
    // Goes red on: deleting the `burnProbeRead` in the capped branch (1 hop
    // instead of 2 — so a fourth request for an address whose allowance is
    // spent answers sooner than one for an address that names nobody, which
    // confirms the address is real), or either probe read in the unknown
    // branch.
    const sentHarness = makeCountingApp();
    await sentHarness.seed("hp-sent@example.com", "hpsent");
    const sent = await sentHarness.measure(() =>
      post(sentHarness.app, "/login/recovery/email/begin", {
        identifier: "hp-sent@example.com",
      }),
    );

    const cappedHarness = makeCountingApp();
    await cappedHarness.seed("hp-cap@example.com", "hpcap");
    for (let i = 0; i < RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX; i++) {
      await requestCode(cappedHarness.app, cappedHarness.recorded, "hp-cap@example.com");
    }
    const capped = await cappedHarness.measure(() =>
      post(cappedHarness.app, "/login/recovery/email/begin", {
        identifier: "hp-cap@example.com",
      }),
    );

    const unknownHarness = makeCountingApp();
    const unknown = await unknownHarness.measure(() =>
      post(unknownHarness.app, "/login/recovery/email/begin", {
        identifier: "hp-nobody@example.com",
      }),
    );

    const total = (h: Hops) => h.pendingRecoveryOtp + h.recoveryEmailBeginCap;
    expect(total(sent)).toBe(2);
    expect(total(capped)).toBe(2);
    expect(total(unknown)).toBe(2);
  });

  it("POST /login/recovery/email/complete — every branch makes the same four hops", async () => {
    // The wrong-code branch is the costliest: the lockout lookup, the entry
    // read, the attempt write, the failure record. Every other branch is padded
    // up to it, including — especially — the one where the identifier resolves
    // to nothing.
    //
    // Goes red on: removing any `burnProbeRead`/`burnLockoutRead` from the
    // unknown, locked or no-pending branches. Deleting the four in the unknown
    // branch alone takes it to 0 hops against the wrong-code branch's 4.

    // (a) a wrong code against a live pending entry — the costliest branch.
    const wrongHarness = makeCountingApp();
    await wrongHarness.seed("hp-wrong@example.com", "hpwrong");
    await requestCode(wrongHarness.app, wrongHarness.recorded, "hp-wrong@example.com");
    const wrong = await wrongHarness.measure(() =>
      post(wrongHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-wrong@example.com",
        code: "000000",
      }),
    );

    // (b) an identifier that names no account.
    const unknownHarness = makeCountingApp();
    const unknown = await unknownHarness.measure(() =>
      post(unknownHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-nobody@example.com",
        code: "000000",
      }),
    );

    // (c) a real account with nothing pending — `begin` was never called.
    const emptyHarness = makeCountingApp();
    await emptyHarness.seed("hp-empty@example.com", "hpempty");
    const empty = await emptyHarness.measure(() =>
      post(emptyHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-empty@example.com",
        code: "000000",
      }),
    );

    // (d) a locked account. Five wrong codes get it there; the sixth is measured.
    const lockedHarness = makeCountingApp();
    await lockedHarness.seed("hp-locked@example.com", "hplocked");
    await requestCode(lockedHarness.app, lockedHarness.recorded, "hp-locked@example.com");
    for (let i = 0; i < 5; i++) {
      await post(lockedHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-locked@example.com",
        code: "000000",
      });
    }
    const locked = await lockedHarness.measure(() =>
      post(lockedHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-locked@example.com",
        code: "000000",
      }),
    );

    // (e) the correct code. Self-identifying at 200, so parity is a bonus here
    //     rather than the guard — but a divergence would still be a smell.
    const okHarness = makeCountingApp();
    await okHarness.seed("hp-ok@example.com", "hpok");
    const good = await requestCode(okHarness.app, okHarness.recorded, "hp-ok@example.com");
    const ok = await okHarness.measure(() =>
      post(okHarness.app, "/login/recovery/email/complete", {
        identifier: "hp-ok@example.com",
        code: good,
      }),
    );

    const shape = (h: Hops) => ({
      pending: h.pendingRecoveryOtp,
      lockout: h.recoveryOtpLockout,
    });
    // Two on the pending-code store, two on the lockout counter, always. The
    // split is asserted as well as the total: a branch that swapped a lockout
    // hop for a pending-store hop would keep the total and lose the shape.
    expect(shape(wrong)).toEqual({ pending: 2, lockout: 2 });
    expect(shape(unknown)).toEqual(shape(wrong));
    expect(shape(empty)).toEqual(shape(wrong));
    expect(shape(locked)).toEqual(shape(wrong));
    expect(shape(ok)).toEqual(shape(wrong));
  });

  it("POST /login/recovery/totp/complete — an unknown identifier costs what a real account costs", async () => {
    // The sharper of the two parity tests: this route resolves through the same
    // `resolveIdentifier`, and the client documents that the identifier "may be
    // a handle or an email address" — so a cheap miss here lets a stranger ask
    // whether an EMAIL ADDRESS has an OSN account.
    //
    // The old padding burned one read against `pendingRecoveryOtp`, a store
    // this ceremony never otherwise touches, while a real account ran the
    // lockout lookup, the credential query and the failure record. Both halves
    // are asserted: the counts must match, and the pending-code store must not
    // be touched at all.
    //
    // Goes red on: replacing `burnTotpCheckCost` with the old
    // `burnProbeRead()` + bare verification, or dropping either lockout read
    // or the credential query from it.

    // (a) a real account with no authenticator — `confirmedCredential` misses,
    //     the verification still runs, the failure is recorded.
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
      pendingRecoveryOtp: h.pendingRecoveryOtp,
    });
    expect(shape(bare)).toEqual({ lockout: 2, credentials: 1, pendingRecoveryOtp: 0 });
    expect(shape(enrolled)).toEqual(shape(bare));
    expect(shape(unknown)).toEqual(shape(bare));
  });
});
