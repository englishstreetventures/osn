import { it, expect, describe } from "@effect/vitest";
import { accounts, emailChanges } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailError, EmailService, type RecordedEmail } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createInMemoryAccountCap } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";
import { confirmedEmailChange, stepUpThroughService } from "../helpers/step-up-link";

/**
 * Build a fresh email recorder + test layer. Tests that need to capture
 * sent links destructure `captured` (a getter over the recorded mail)
 * and provide `layer` at `Effect.provide` time. Also exposes the raw
 * SQLite handle behind the layer for tests that need to install a
 * fault-injection trigger the service layer has no route to create.
 */
function makeEmailCapture() {
  const { layer, sqlite, email } = createTestLayerWithSqlite();
  return {
    layer,
    sqlite,
    captured: {
      recorded: () => email.recorded(),
      /** Every `email-changed` notice sent so far. */
      notices: () => email.recorded().filter((e) => e.template === "email-changed"),
    },
  };
}

type RawSqlite = ReturnType<typeof createTestLayerWithSqlite>["sqlite"];

/** How many `email_changed` security events `accountId` holds. */
const changeEventsOf = (sqlite: RawSqlite, accountId: string): number =>
  (
    sqlite
      .query(
        "SELECT count(*) AS n FROM security_events WHERE account_id = ? AND kind = 'email_changed'",
      )
      .get(accountId) as { n: number }
  ).n;

/** Who each notice went to. */
const recipientsOf = (notices: readonly RecordedEmail[]): string[] => notices.map((e) => e.to);

type AuthService = ReturnType<typeof createAuthService>;

/** Completes a confirmed change, waiting for the notice it forks. */
const completeSettled = (
  auth: AuthService,
  profile: { readonly id: string; readonly accountId: string },
  request: { readonly requestId: string; readonly claimSecret: string },
  stepUpToken: string,
  eventMeta?: { ip?: string; uaLabel?: string },
) =>
  settle(
    auth.completeEmailChange(
      profile.accountId,
      profile.id,
      request.requestId,
      request.claimSecret,
      stepUpToken,
      null,
      eventMeta,
    ),
  );

/**
 * Email-change ceremony:
 *   • begin sends a link to the NEW email (verifying deliverability).
 *   • complete requires BOTH that link confirmed AND a valid step-up token.
 *   • On success every OTHER session is revoked atomically with the
 *     accounts.email swap.
 *   • Hard cap of 2 successful changes per trailing 7 days — honours
 *     typo-and-correction but blocks account-stuffing churn.
 */

let baseConfig: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  baseConfig = await makeTestAuthConfig();
});

/** Shared helper: register and mint a step-up token through the emailed link. */
const setup = (
  email: string,
  handle: string,
  captured: ReturnType<typeof makeEmailCapture>["captured"],
) =>
  Effect.gen(function* () {
    const auth = createAuthService(baseConfig);
    const profile = yield* auth.registerProfile(email, handle);
    const stepUpToken = yield* stepUpThroughService(
      auth,
      profile.accountId,
      "email_change",
      captured.recorded,
    );
    return { auth, profile, stepUpToken };
  });

describe("beginEmailChange + completeEmailChange", () => {
  it.effect("happy path: swaps email, returns the new address, revokes other sessions", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-happy@example.com",
        "echappy",
        captured,
      );

      // Caller's "current" session; should survive the change.
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Another device.
      const other = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      const otpCode = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-happy-new@example.com",
        captured.recorded,
      );
      const result = yield* auth.completeEmailChange(
        profile.accountId,
        profile.id,
        otpCode.requestId,
        otpCode.claimSecret,
        stepUpToken,
        auth.hashSessionToken(me.refreshToken),
      );
      expect(result.email).toBe("ec-happy-new@example.com");

      // Current session survives; other is gone.
      yield* auth.verifyRefreshToken(me.refreshToken);
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a missing / invalid step-up token", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-nostepup@example.com", "ecnostepup", captured);
      const begun = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-nostepup-new@example.com",
        captured.recorded,
      );
      const err = yield* Effect.flip(
        auth.completeEmailChange(
          profile.accountId,
          profile.id,
          begun.requestId,
          begun.claimSecret,
          "not.a.jwt",
          null,
        ),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toBe("Invalid step-up token");
    }).pipe(Effect.provide(layer));
  });

  // Write-time guard: the begin-time collision check only sees
  // accounts as they stand *right then*. Account B can grab the target
  // address (via its own, independent change) in the gap between account
  // A's begin (collision check passes — nobody holds it yet) and A's
  // complete. At that point the write hits UNIQUE(email) for real, and
  // the catch in `completeEmailChange` must turn that into the same
  // generic AuthError an unconfirmed link returns — never a raw
  // DatabaseError, and never a hint that the address is taken.
  it.effect("rejects at complete time when another account wins the email in the meantime", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const { db } = yield* Db;
      const a = yield* setup("ec-race-a@example.com", "ecracea", captured);
      const b = yield* setup("ec-race-b@example.com", "ecraceb", captured);

      const target = "ec-race-target@example.com";

      // A begins first — target is free, so the collision check passes
      // and a pending change is stored.
      const codeA = yield* confirmedEmailChange(
        a.auth,
        a.profile.accountId,
        target,
        captured.recorded,
      );

      // B independently begins AND completes a change to the same
      // address before A completes — same target is still free from
      // B's point of view too.
      const codeB = yield* confirmedEmailChange(
        b.auth,
        b.profile.accountId,
        target,
        captured.recorded,
      );
      const bResult = yield* completeSettled(b.auth, b.profile, codeB, b.stepUpToken);
      expect(bResult.email).toBe(target);

      // A refreshes before the failed complete — proves A's session is
      // untouched by the collision, not just A's email.
      const aTokens = yield* a.auth.issueTokens(
        a.profile.id,
        a.profile.accountId,
        a.profile.email,
        a.profile.handle,
        a.profile.displayName,
      );

      // A's write now collides for real: B already owns `target`.
      const err = yield* Effect.flip(completeSettled(a.auth, a.profile, codeA, a.stepUpToken));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired link/i);
      // Regression pin: the conflict branch tags its metric bucket
      // explicitly rather than leaving it to `classifyError`'s substring
      // match (which would also fire here, but for the wrong reason).
      expect(err).toMatchObject({ metricResult: "conflict" });

      // Invariant pins, not half-applied-batch/rollback detectors: the
      // first batch statement (the accounts update) is what throws the
      // UNIQUE violation, so the emailChanges insert and sessions delete
      // never execute. These assert nothing about A changed, not that a
      // partial write was rolled back.
      const [aAccount] = yield* Effect.promise(async () =>
        db.select().from(accounts).where(eq(accounts.id, a.profile.accountId)).all(),
      );
      expect(aAccount?.email).toBe("ec-race-a@example.com");
      const [bAccount] = yield* Effect.promise(async () =>
        db.select().from(accounts).where(eq(accounts.id, b.profile.accountId)).all(),
      );
      expect(bAccount?.email).toBe(target);
      const aEmailChanges = yield* Effect.promise(async () =>
        db.select().from(emailChanges).where(eq(emailChanges.accountId, a.profile.accountId)).all(),
      );
      expect(aEmailChanges).toHaveLength(0);

      // A's pre-existing session still verifies — the failed complete
      // didn't touch sessions at all (its claim removes only the pending
      // ceremony state, never a session).
      yield* a.auth.verifyRefreshToken(aTokens.refreshToken);

      // The refused change records no event and mails no notice; B's change
      // mailed the address B held before it.
      expect(changeEventsOf(sqlite, a.profile.accountId)).toBe(0);
      expect(recipientsOf(captured.notices())).toEqual(["ec-race-b@example.com"]);
    }).pipe(Effect.provide(layer));
  });

  // Positive control for the race test above: proves the ceremony still
  // succeeds end-to-end when the target address really is free, on the
  // same shared email recorder / call-ordering the race test relies on.
  it.effect("succeeds completing a change to a free address (positive control)", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const c = yield* setup("ec-race-c@example.com", "ecracec", captured);
      const codeC = yield* confirmedEmailChange(
        c.auth,
        c.profile.accountId,
        "ec-race-c-new@example.com",
        captured.recorded,
      );
      const result = yield* c.auth.completeEmailChange(
        c.profile.accountId,
        c.profile.id,
        codeC.requestId,
        codeC.claimSecret,
        c.stepUpToken,
        null,
      );
      expect(result.email).toBe("ec-race-c-new@example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an invalid new-email address", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-badaddr@example.com", "ecbadaddr", captured);
      const err = yield* Effect.flip(auth.beginEmailChange(profile.accountId, "not-an-email"));
      expect(err._tag).toBe("ValidationError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a change to the caller's own current email", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-selfemail@example.com", "ecselfemail", captured);
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-selfemail@example.com"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/matches current email/i);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a change to the caller's own email in a different case", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-selfcase@example.com", "ecselfcase", captured);
      // EmailSchema accepts uppercase (the guard normalises before comparing,
      // so decode alone must not swallow this).
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "EC-SELFCASE@EXAMPLE.COM"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/matches current email/i);
    }).pipe(Effect.provide(layer));
  });

  // #520: begin is capped per-account independently of the per-IP rate
  // limiter. makeTestAuthConfig() sets no cap/TTL overrides, so exercising
  // this requires building a service with an injected emailChangeBeginCap
  // rather than relying on the shared test config.
  it.effect("caps the number of email-change begins per account", () => {
    const { layer } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService({
        ...baseConfig,
        emailChangeBeginCap: createInMemoryAccountCap(2, 60_000),
      });
      const profile = yield* auth.registerProfile("ec-begincap@example.com", "ecbegincap");
      yield* auth.beginEmailChange(profile.accountId, "ec-begincap-1@example.com");
      yield* auth.beginEmailChange(profile.accountId, "ec-begincap-2@example.com");
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-begincap-3@example.com"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/too many email change attempts/i);
    }).pipe(Effect.provide(layer));
  });

  // Regression pin: a non-uniqueness constraint failure at the write
  // must surface as DatabaseError, never get folded into the same generic
  // AuthError the refused-link/UNIQUE-conflict paths return. FK enforcement
  // is on in this tree (`PRAGMA foreign_keys = ON`, see `@osn/db/testing`),
  // but `email_changes.accountId` deliberately carries no FK reference (see
  // the schema comment on that column), so no real FK violation is reachable
  // through this table — a fault-injection trigger stands in for "some other
  // constraint failed".
  it.effect("surfaces a non-uniqueness constraint failure as DatabaseError", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-fault@example.com",
        "ecfault",
        captured,
      );
      const code = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-fault-new@example.com",
        captured.recorded,
      );

      sqlite.exec(
        `CREATE TRIGGER ec_force_fault BEFORE INSERT ON email_changes
         BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: email_changes.new_email'); END;`,
      );

      const err = yield* Effect.flip(completeSettled(auth, profile, code, stepUpToken));
      expect(err._tag).toBe("DatabaseError");
      // bun:sqlite runs the statements one at a time, so the swap stands
      // although its audit row failed. The account holds the new address, so
      // the address it replaced still hears of it. (On D1 the batch rolls back
      // whole; tests/d1/conditional-writes.test.ts covers that.)
      const row = sqlite
        .query("SELECT email FROM accounts WHERE id = ?")
        .get(profile.accountId) as {
        email: string;
      };
      expect(row.email).toBe("ec-fault-new@example.com");
      expect(recipientsOf(captured.notices())).toEqual(["ec-fault@example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects completing a request that does not exist", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-nopending@example.com",
        "ecnopending",
        captured,
      );
      const err = yield* Effect.flip(
        auth.completeEmailChange(
          profile.accountId,
          profile.id,
          "emailchange_000000000000",
          "0".repeat(64),
          stepUpToken,
          null,
        ),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired link/i);
    }).pipe(Effect.provide(layer));
  });

  // Expiry is wall-clock (`Date.now()` comparisons), so this must
  // run on the real clock. it.effect's TestClock suspends Effect.sleep until
  // manually advanced — it would hang here, and advancing it wouldn't help
  // since the service never reads TestClock. it.live is required.
  it.live("rejects completing after the pending change has expired", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService({ ...baseConfig, otpTtl: 1 });
      const profile = yield* auth.registerProfile("ec-expired@example.com", "ecexpired");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "email_change",
        captured.recorded,
      );
      const code = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-expired-new@example.com",
        captured.recorded,
      );

      // Real wall-clock sleep past the 1s otpTtl, with 500ms of CI slack.
      // Kept as short as the margin allows: this is the only real sleep in the
      // package and it is paid on every run.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1500)));

      const err = yield* Effect.flip(
        auth.completeEmailChange(
          profile.accountId,
          profile.id,
          code.requestId,
          code.claimSecret,
          stepUpToken,
          null,
        ),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired link/i);
    }).pipe(Effect.provide(layer));
  });

  // Proves a conflicted change spends its request. Extends the race test's
  // world: A's complete already lost the genuine UNIQUE race once, after its
  // claim spent the request. A second, non-uniqueness fault is then installed
  // and A resubmits with a fresh token — with the request spent this
  // short-circuits (AuthError) rather than ever reaching the write and turning
  // into a DatabaseError. Were the request to survive the conflict, this
  // assertion would catch it.
  it.effect("a conflicted pending change cannot be resurrected by retrying", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const a = yield* setup("ec-s2-a@example.com", "ecs2a", captured);
      const b = yield* setup("ec-s2-b@example.com", "ecs2b", captured);

      const target = "ec-s2-target@example.com";

      const codeA = yield* confirmedEmailChange(
        a.auth,
        a.profile.accountId,
        target,
        captured.recorded,
      );

      const codeB = yield* confirmedEmailChange(
        b.auth,
        b.profile.accountId,
        target,
        captured.recorded,
      );
      yield* b.auth.completeEmailChange(
        b.profile.accountId,
        b.profile.id,
        codeB.requestId,
        codeB.claimSecret,
        b.stepUpToken,
        null,
      );

      // Genuine UNIQUE conflict must happen first — installing the second
      // trigger before this would mask it.
      const firstErr = yield* Effect.flip(
        a.auth.completeEmailChange(
          a.profile.accountId,
          a.profile.id,
          codeA.requestId,
          codeA.claimSecret,
          a.stepUpToken,
          null,
        ),
      );
      expect(firstErr._tag).toBe("AuthError");

      sqlite.exec(
        `CREATE TRIGGER ec_block_update BEFORE UPDATE ON accounts
         BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: accounts.email'); END;`,
      );

      const freshStepUpToken = yield* stepUpThroughService(
        a.auth,
        a.profile.accountId,
        "email_change",
        captured.recorded,
      );

      const secondErr = yield* Effect.flip(
        a.auth.completeEmailChange(
          a.profile.accountId,
          a.profile.id,
          codeA.requestId,
          codeA.claimSecret,
          freshStepUpToken,
          null,
        ),
      );
      // The request was claimed by the conflicted complete, so this
      // short-circuits at the poll — AuthError. A surviving entry would reach the write, where
      // `ec_block_update` fires a non-UNIQUE message that the complete
      // re-throws as DatabaseError.
      expect(secondErr._tag).toBe("AuthError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("enforces 2-per-7-days cap", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-cap@example.com", "eccap");

      const issueStepUp = stepUpThroughService(
        auth,
        profile.accountId,
        "email_change",
        captured.recorded,
      );

      const performChange = (newEmail: string) =>
        Effect.gen(function* () {
          const stepUpToken = yield* issueStepUp;
          const code = yield* confirmedEmailChange(
            auth,
            profile.accountId,
            newEmail,
            captured.recorded,
          );
          return yield* auth.completeEmailChange(
            profile.accountId,
            profile.id,
            code.requestId,
            code.claimSecret,
            stepUpToken,
            null,
          );
        });

      yield* performChange("ec-cap-1@example.com");
      yield* performChange("ec-cap-2@example.com");
      // Third change inside 7 days must be rejected.
      const err = yield* Effect.flip(performChange("ec-cap-3@example.com"));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/limit reached/i);
    }).pipe(Effect.provide(layer));
  });

  // The 7-day cap check must run BEFORE the collision probe, so a
  // capped caller can't tell a taken address from a free one by comparing
  // which failure they get. Drives the cap directly via raw rows (cheaper
  // than two full ceremonies) rather than reusing "enforces 2-per-7-days
  // cap" above.
  it.effect("caps identically regardless of whether the target address is taken", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup(
        "ec-capcollision@example.com",
        "eccapcollision",
        captured,
      );
      // Another account already owns this address.
      yield* auth.registerProfile("ec-capcollision-taken@example.com", "eccapcollisiontaken");

      const nowSec = Math.floor(Date.now() / 1000);
      for (const suffix of ["1", "2"]) {
        sqlite
          .query(
            `INSERT INTO email_changes (id, account_id, previous_email, new_email, completed_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `ech_capcollision_${suffix}`,
            profile.accountId,
            "ec-capcollision-old@example.com",
            `ec-capcollision-new-${suffix}@example.com`,
            nowSec,
          );
      }

      const takenErr = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-capcollision-taken@example.com"),
      );
      const freeErr = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-capcollision-free@example.com"),
      );
      expect(takenErr._tag).toBe("AuthError");
      expect(freeErr._tag).toBe("AuthError");
      expect(takenErr.message).toMatch(/limit reached/i);
      expect(freeErr.message).toBe(takenErr.message);
    }).pipe(Effect.provide(layer));
  });
});

/**
 * The cap holds at the commit, not only at the preflight: two different
 * requests — one claimed, then a second begun and completed — each pass their own
 * preflight with one change on record, and only one may commit. Each case
 * holds a statement of the first completion's commit while the second runs.
 */
/**
 * A completed change is recorded as an `email_changed` security event, in the
 * commit, and mailed to the address it replaced, after the commit. A refused
 * change does neither. Every completion whose mail is counted runs under
 * `settle`, so a notice it wrongly sent is on record before the count.
 */
describe("the change notice", () => {
  it.effect(
    "a completed change records one email_changed event, with the device it came from",
    () => {
      const { layer, captured, sqlite } = makeEmailCapture();
      return Effect.gen(function* () {
        // With a pepper configured, so the IP is stored hashed, not dropped.
        const auth = createAuthService({ ...baseConfig, sessionIpPepper: "x".repeat(32) });
        const profile = yield* auth.registerProfile("ec-ev@example.com", "ecev");
        const token = yield* auth.issueStepUpToken(profile.accountId, "otp", "email_change");
        const request = yield* confirmedEmailChange(
          auth,
          profile.accountId,
          "ec-ev-new@example.com",
          captured.recorded,
        );
        yield* completeSettled(auth, profile, request, token, {
          ip: "203.0.113.7",
          uaLabel: "Firefox on macOS",
        });

        expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
        const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
        const event = events.find((e) => e.kind === "email_changed");
        expect(event?.uaLabel).toBe("Firefox on macOS");
        expect(event?.ipHash).toMatch(/^[a-f0-9]{64}$/);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a completed change mails the address it replaced, naming the new one masked", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-mail@example.com",
        "ecmail",
        captured,
      );
      // A first letter and a domain unlike the old address's, so the body
      // shows which of the two it names.
      const request = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "zed-new@elsewhere.test",
        captured.recorded,
      );
      yield* completeSettled(auth, profile, request, stepUpToken);

      const notices = captured.notices();
      expect(recipientsOf(notices)).toEqual(["ec-mail@example.com"]);
      expect(notices[0]!.text).toContain("z•••@elsewhere.test");
      expect(notices[0]!.text).not.toContain("zed-new");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a change refused by the cap records no event and mails no notice", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-capev@example.com",
        "eccapev",
        captured,
      );
      const request = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-capev-new@example.com",
        captured.recorded,
      );
      // Two changes land on record after the begin, so the complete's
      // preflight finds the cap reached.
      const nowSec = Math.floor(Date.now() / 1000);
      for (const suffix of ["1", "2"]) {
        sqlite
          .query(
            `INSERT INTO email_changes (id, account_id, previous_email, new_email, completed_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `ech_capev_${suffix}`,
            profile.accountId,
            "ec-capev-old@example.com",
            `ec-capev-seed-${suffix}@example.com`,
            nowSec,
          );
      }

      const err = yield* Effect.flip(completeSettled(auth, profile, request, stepUpToken));
      expect(err.message).toMatch(/limit reached/i);
      expect(changeEventsOf(sqlite, profile.accountId)).toBe(0);
      expect(captured.notices()).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a mailer that refuses the notice does not fail the change", () => {
    const { layer: base, sqlite, email } = createTestLayerWithSqlite();
    let refused = 0;
    const refusingNotice = Layer.effect(
      EmailService,
      Effect.gen(function* () {
        const inner = yield* EmailService;
        return {
          send: (input) =>
            input.template === "email-changed"
              ? Effect.sync(() => {
                  refused++;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(new EmailError({ reason: "dispatch_failed", cause: 403 })),
                  ),
                )
              : inner.send(input),
        };
      }),
    ).pipe(Layer.provide(email.layer));
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-refuse@example.com", "ecrefuse");
      const token = yield* auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      const request = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-refuse-new@example.com",
        () => email.recorded(),
      );
      const result = yield* completeSettled(auth, profile, request, token);
      expect(result.email).toBe("ec-refuse-new@example.com");
      expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
      expect(refused).toBe(1);
    }).pipe(Effect.provide(Layer.merge(base, refusingNotice)));
  });

  // The commit can report a failure for a change that stands: D1 can fail a
  // batch it has committed, and on bun:sqlite a later statement can throw
  // after the change is on record. The change is then the account's, so its
  // notice still goes out — once: a retry of the same request that finds the
  // change on record answers it, writes the missing event, and mails nothing.
  it.effect(
    "a change on record whose commit reported a failure is mailed once and answered on retry",
    () => {
      const { layer, captured, sqlite } = makeEmailCapture();
      return Effect.gen(function* () {
        const { auth, profile, stepUpToken } = yield* setup(
          "ec-ambig@example.com",
          "ecambig",
          captured,
        );
        const request = yield* confirmedEmailChange(
          auth,
          profile.accountId,
          "ec-ambig-new@example.com",
          captured.recorded,
        );
        sqlite.exec(
          `CREATE TRIGGER ec_event_fault BEFORE INSERT ON security_events
           BEGIN SELECT RAISE(ABORT, 'simulated failure after the change is on record'); END;`,
        );

        const err = yield* Effect.flip(completeSettled(auth, profile, request, stepUpToken));
        expect(err._tag).toBe("DatabaseError");
        const row = sqlite
          .query("SELECT email FROM accounts WHERE id = ?")
          .get(profile.accountId) as { email: string };
        expect(row.email).toBe("ec-ambig-new@example.com");
        expect(recipientsOf(captured.notices())).toEqual(["ec-ambig@example.com"]);
        expect(changeEventsOf(sqlite, profile.accountId)).toBe(0);

        // The fault passes; the tab steps up again and retries.
        sqlite.exec("DROP TRIGGER ec_event_fault");
        const again = yield* stepUpThroughService(
          auth,
          profile.accountId,
          "email_change",
          captured.recorded,
        );
        const retried = yield* completeSettled(auth, profile, request, again);
        expect(retried.email).toBe("ec-ambig-new@example.com");
        const changes = sqlite
          .query("SELECT count(*) AS n FROM email_changes WHERE account_id = ?")
          .get(profile.accountId) as { n: number };
        expect(changes.n).toBe(1);
        expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
        expect(recipientsOf(captured.notices())).toEqual(["ec-ambig@example.com"]);

        // Spent: a third try is refused and writes nothing.
        const third = yield* stepUpThroughService(
          auth,
          profile.accountId,
          "email_change",
          captured.recorded,
        );
        const refused = yield* Effect.flip(completeSettled(auth, profile, request, third));
        expect(refused._tag).toBe("AuthError");
        expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
        expect(captured.notices()).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("the 2-per-7-days cap under concurrent completions", () => {
  /** The service on a database whose statements a test can hold. */
  function makeHeldEmailCapture() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const held = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: held.db }), email.layer),
      sqlite,
      hold: held.hold,
      recorded: () => email.recorded(),
      notices: () => email.recorded().filter((e) => e.template === "email-changed"),
    };
  }

  /** One completed change on record for `accountId`, inside the window. */
  const seedOneChange = (sqlite: ReturnType<typeof makeHeldEmailCapture>["sqlite"], id: string) =>
    sqlite
      .query(
        `INSERT INTO email_changes (id, account_id, previous_email, new_email, completed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`ech_seed_${id}`, id, "seed-old@example.com", "seed-new@example.com", nowSec());

  const nowSec = () => Math.floor(Date.now() / 1000);

  const changesOf = (
    sqlite: ReturnType<typeof makeHeldEmailCapture>["sqlite"],
    accountId: string,
  ): string[] =>
    (
      sqlite
        .query("SELECT new_email FROM email_changes WHERE account_id = ? ORDER BY new_email")
        .all(accountId) as { new_email: string }[]
    ).map((row) => row.new_email);

  const emailOf = (sqlite: ReturnType<typeof makeHeldEmailCapture>["sqlite"], accountId: string) =>
    (sqlite.query("SELECT email FROM accounts WHERE id = ?").get(accountId) as { email: string })
      .email;

  it.live("a completion that counted one change is refused once another has committed", () => {
    const { layer, sqlite, hold, recorded, notices } = makeHeldEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-edge@example.com", "ecedge");
      seedOneChange(sqlite, profile.accountId);
      const [tokenA, tokenB] = yield* Effect.all(
        [0, 1].map(() => auth.issueStepUpToken(profile.accountId, "otp", "email_change")),
      );

      const codeA = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-edge-a@example.com",
        recorded,
      );
      // A's commit waits at its first statement, after its claim and its
      // preflight have read one change on record.
      const commitA = hold(/^update "accounts" set "email"/);
      const a = yield* Effect.forkChild(
        Effect.result(completeSettled(auth, profile, codeA, tokenA!)),
      );
      yield* Effect.promise(() => commitA.reached);

      const codeB = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-edge-b@example.com",
        recorded,
      );
      const b = yield* completeSettled(auth, profile, codeB, tokenB!);
      expect(b.email).toBe("ec-edge-b@example.com");
      // A session opened after B's change, which A's commit must not end.
      const later = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        b.email,
        profile.handle,
        profile.displayName,
      );

      commitA.release();
      const outcome = yield* Fiber.join(a);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("AuthError");
        expect(outcome.failure.message).toMatch(/limit reached/i);
      }
      expect(changesOf(sqlite, profile.accountId)).toEqual([
        "ec-edge-b@example.com",
        "seed-new@example.com",
      ]);
      expect(emailOf(sqlite, profile.accountId)).toBe("ec-edge-b@example.com");
      yield* auth.verifyRefreshToken(later.refreshToken);
      // Only the change that stands is recorded and mailed: A's statements
      // all find the cap reached, its security event included.
      expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
      expect(recipientsOf(notices())).toEqual(["ec-edge@example.com"]);
    }).pipe(Effect.provide(layer));
  });

  // A's preflight reads the address, then its commit waits while B's whole
  // change commits. A's swap names the address A read, so it moves nothing
  // once B has moved it, and only B's change is recorded and mailed.
  it.live("a completion whose preflight address was since replaced is refused", () => {
    const { layer, sqlite, hold, recorded, notices } = makeHeldEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-stale@example.com", "ecstale");
      const [tokenA, tokenB] = yield* Effect.all(
        [0, 1].map(() => auth.issueStepUpToken(profile.accountId, "otp", "email_change")),
      );

      const codeA = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-stale-a@example.com",
        recorded,
      );
      const commitA = hold(/^update "accounts" set "email"/);
      const a = yield* Effect.forkChild(
        Effect.result(completeSettled(auth, profile, codeA, tokenA!)),
      );
      yield* Effect.promise(() => commitA.reached);

      const codeB = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-stale-b@example.com",
        recorded,
      );
      yield* completeSettled(auth, profile, codeB, tokenB!);

      commitA.release();
      const outcome = yield* Fiber.join(a);
      expect(outcome._tag).toBe("Failure");
      expect(emailOf(sqlite, profile.accountId)).toBe("ec-stale-b@example.com");
      expect(changesOf(sqlite, profile.accountId)).toEqual(["ec-stale-b@example.com"]);
      expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
      expect(recipientsOf(notices())).toEqual(["ec-stale@example.com"]);
    }).pipe(Effect.provide(layer));
  });

  // A commit that reports a failure after its change went on record still
  // mails the address it replaced, even once a later change has moved the
  // account on: the account's address alone no longer shows the change stood.
  it.live("a recorded change whose commit then failed is mailed after a later change", () => {
    const { layer, sqlite, hold, recorded, notices } = makeHeldEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-later@example.com", "eclater");
      const [tokenA, tokenB] = yield* Effect.all(
        [0, 1].map(() => auth.issueStepUpToken(profile.accountId, "otp", "email_change")),
      );

      const codeA = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-later-a@example.com",
        recorded,
      );
      // A's change is on record; its security event waits.
      const eventA = hold(/^insert into "security_events"/);
      const a = yield* Effect.forkChild(
        Effect.result(completeSettled(auth, profile, codeA, tokenA!)),
      );
      yield* Effect.promise(() => eventA.reached);

      const codeB = yield* confirmedEmailChange(
        auth,
        profile.accountId,
        "ec-later-b@example.com",
        recorded,
      );
      yield* completeSettled(auth, profile, codeB, tokenB!);

      // A's event now fails, so A's commit reports a failure.
      sqlite.exec(
        `CREATE TRIGGER ec_later_fault BEFORE INSERT ON security_events
         BEGIN SELECT RAISE(ABORT, 'simulated failure after the change is on record'); END;`,
      );
      eventA.release();
      const outcome = yield* Fiber.join(a);
      expect(outcome._tag).toBe("Failure");
      expect(emailOf(sqlite, profile.accountId)).toBe("ec-later-b@example.com");
      // B mailed the address it replaced; A mailed the one A replaced.
      expect(recipientsOf(notices())).toEqual(["ec-later-a@example.com", "ec-later@example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "when two commits' statements interleave, the address that stands is the one recorded",
    () => {
      const { layer, sqlite, hold, recorded, notices } = makeHeldEmailCapture();
      return Effect.gen(function* () {
        const auth = createAuthService(baseConfig);
        const profile = yield* auth.registerProfile("ec-weave@example.com", "ecweave");
        seedOneChange(sqlite, profile.accountId);
        const [tokenA, tokenB] = yield* Effect.all(
          [0, 1].map(() => auth.issueStepUpToken(profile.accountId, "otp", "email_change")),
        );

        // A's address goes in; its audit row waits.
        const codeA = yield* confirmedEmailChange(
          auth,
          profile.accountId,
          "ec-weave-a@example.com",
          recorded,
        );
        const recordA = hold(/^insert into "email_changes"/);
        const a = yield* Effect.forkChild(
          Effect.result(completeSettled(auth, profile, codeA, tokenA!)),
        );
        yield* Effect.promise(() => recordA.reached);

        // B's address goes in over A's; its audit row waits too.
        const codeB = yield* confirmedEmailChange(
          auth,
          profile.accountId,
          "ec-weave-b@example.com",
          recorded,
        );
        const recordB = hold(/^insert into "email_changes"/);
        const b = yield* Effect.forkChild(
          Effect.result(completeSettled(auth, profile, codeB, tokenB!)),
        );
        yield* Effect.promise(() => recordB.reached);

        recordA.release();
        const outcomeA = yield* Fiber.join(a);
        recordB.release();
        const outcomeB = yield* Fiber.join(b);

        expect(outcomeA._tag).toBe("Failure");
        if (outcomeA._tag === "Failure") expect(outcomeA.failure._tag).toBe("AuthError");
        expect(outcomeB._tag).toBe("Success");
        if (outcomeB._tag === "Success")
          expect(outcomeB.success.email).toBe("ec-weave-b@example.com");
        expect(emailOf(sqlite, profile.accountId)).toBe("ec-weave-b@example.com");
        expect(changesOf(sqlite, profile.accountId)).toEqual([
          "ec-weave-b@example.com",
          "seed-new@example.com",
        ]);
        expect(changeEventsOf(sqlite, profile.accountId)).toBe(1);
        expect(notices()).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
