import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * M-PK1b: security_events audit trail + out-of-band notification.
 *
 * Invariants we care about:
 *   • generateRecoveryCodesForAccount writes one unacked security_events row
 *     per call, in the same transaction as the code swap.
 *   • consumeRecoveryCode writes one unacked security_events row per
 *     successful consumption (S-H1) — the takeover half of the threat model.
 *   • listUnacknowledgedSecurityEvents surfaces only unacked rows, newest
 *     first, with the coarse UA label we threaded in from the route.
 *   • acknowledgeSecurityEvent is step-up gated (S-M1), idempotent on missing
 *     / already-acked IDs, and scoped to the owning account.
 *   • If `sendEmail` rejects, the recovery codes still commit — the email is
 *     forked + timed-out defence in depth, not the primary signal.
 */

let baseConfig: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  baseConfig = await makeTestAuthConfig();
});

const registered = (auth: ReturnType<typeof createAuthService>, email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    return profile;
  });

/**
 * Drives the OTP step-up ceremony and returns a single-use token. Each call
 * mints a fresh token — step-up jti is consumed on first verify, so tests
 * that ack multiple events need one token per ack OR a bulk-ack call.
 */
const mintStepUp = (
  auth: ReturnType<typeof createAuthService>,
  accountId: string,
  captured: string[],
) =>
  Effect.gen(function* () {
    yield* auth.beginStepUpOtp(accountId);
    const code = captured[captured.length - 1]!;
    const { stepUpToken } = yield* auth.completeStepUpOtp(accountId, code);
    return stepUpToken;
  });

const makeCapturingAuth = () => {
  const captured: string[] = [];
  const auth = createAuthService({
    ...baseConfig,
    sendEmail: async (_to, _subject, body) => {
      const m = body.match(/(?:code is|OSN step-up code is): (\d{6})/);
      if (m) captured.push(m[1]!);
    },
  });
  return { auth, captured };
};

describe("generateRecoveryCodesForAccount → security_events", () => {
  it.effect("creates exactly one unacked row per generate call", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-one@example.com", "sevone");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const afterFirst = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(afterFirst.events).toHaveLength(1);
      expect(afterFirst.events[0]!.kind).toBe("recovery_code_generate");
      expect(afterFirst.events[0]!.id).toMatch(/^sev_[a-f0-9]{12}$/);

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const afterSecond = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(afterSecond.events).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("captures the UA label + ip hash when passed as eventMeta", () =>
    Effect.gen(function* () {
      const auth = createAuthService({ ...baseConfig, sessionIpPepper: "x".repeat(32) });
      const profile = yield* registered(auth, "sev-meta@example.com", "sevmeta");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId, {
        uaLabel: "Firefox on macOS",
        ip: "203.0.113.7",
      });

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events[0]!.uaLabel).toBe("Firefox on macOS");
      expect(events[0]!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The email notification is forked + timed out. A failing sendEmail must
  // not roll back the generate — that would let an attacker DoS the recovery
  // surface by making the inbox reject mail.
  it.effect("generate still succeeds when sendEmail rejects", () =>
    Effect.gen(function* () {
      const auth = createAuthService({
        ...baseConfig,
        sendEmail: async () => {
          throw new Error("simulated SMTP failure");
        },
      });
      const profile = yield* registered(auth, "sev-mailfail@example.com", "sevmailfail");

      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      expect(codes).toHaveLength(10);

      // Audit row still committed.
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("consumeRecoveryCode → security_events (S-H1)", () => {
  it.effect("records a recovery_code_consume audit row in the consume transaction", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-consume@example.com", "sevconsume");

      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      // One event from the generate.
      const afterGen = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(afterGen.events).toHaveLength(1);
      expect(afterGen.events[0]!.kind).toBe("recovery_code_generate");

      // Consume — should add a second row, kind recovery_code_consume.
      yield* auth.consumeRecoveryCode("sev-consume@example.com", codes[0]!);
      const afterConsume = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(afterConsume.events).toHaveLength(2);
      expect(afterConsume.events.map((e) => e.kind).sort()).toEqual([
        "recovery_code_consume",
        "recovery_code_generate",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("threads UA + IP hash from eventMeta onto the consume audit row", () =>
    Effect.gen(function* () {
      const auth = createAuthService({ ...baseConfig, sessionIpPepper: "x".repeat(32) });
      const profile = yield* registered(auth, "sev-consume-meta@example.com", "sevconsumemeta");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      yield* auth.consumeRecoveryCode("sev-consume-meta@example.com", codes[0]!, {
        uaLabel: "Safari on iOS",
        ip: "198.51.100.2",
      });
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      const consumeRow = events.find((e) => e.kind === "recovery_code_consume");
      expect(consumeRow).toBeDefined();
      expect(consumeRow!.uaLabel).toBe("Safari on iOS");
      expect(consumeRow!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Failed consume attempts (invalid code, unknown identifier) must NOT
  // record an audit row — we only record on true takeover events.
  it.effect("failed consume attempts do not record an audit row", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-badcode@example.com", "sevbadcode");
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      // The generate recorded one row; no new rows should appear after a
      // failed consume.
      yield* Effect.flip(
        auth.consumeRecoveryCode("sev-badcode@example.com", "dead-beef-cafe-0000"),
      );
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("recovery_code_generate");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("listUnacknowledgedSecurityEvents", () => {
  it.effect("returns all unacked rows and respects the newest-first contract", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-order@example.com", "sevorder");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events).toHaveLength(2);
      expect(events[0]!.createdAt).toBeGreaterThanOrEqual(events[1]!.createdAt);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not leak events from another account", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const a = yield* registered(auth, "sev-a@example.com", "seva");
      const b = yield* registered(auth, "sev-b@example.com", "sevb");

      yield* auth.generateRecoveryCodesForAccount(a.accountId);
      yield* auth.generateRecoveryCodesForAccount(b.accountId);

      const listA = yield* auth.listUnacknowledgedSecurityEvents(a.accountId);
      expect(listA.events).toHaveLength(1);
      expect(listA.events[0]!.id).toMatch(/^sev_/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-S1: the service caps results at .limit(50). A regression that drops
  // the cap (or the isNull filter) would silently leak unbounded data into
  // the Settings banner.
  it.effect("caps results at 50 even when more unacked rows exist", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-cap@example.com", "sevcap");
      for (let i = 0; i < 55; i++) {
        yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      }
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events).toHaveLength(50);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-S1: ack + list mixed state — only unacked rows survive the filter.
  it.effect("excludes acknowledged rows when mixed with unacked rows", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-mix@example.com", "sevmix");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      const beforeAck = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(beforeAck.events).toHaveLength(3);

      // Ack the newest row; the other two must still surface.
      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);
      yield* auth.acknowledgeSecurityEvent(profile.accountId, beforeAck.events[0]!.id, stepUpToken);
      const afterAck = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(afterAck.events).toHaveLength(2);
      const ids = new Set(afterAck.events.map((e) => e.id));
      expect(ids.has(beforeAck.events[0]!.id)).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// T-S2: the defensive branches in notifyRecovery are unreachable in production
// (FK + step-up guarantee an account exists, and the mailer is configured in
// deploy envs). Silent drift that removes the null-check could leak a "sent"
// metric for a notification that never actually dispatched. Pin it.
describe("notifyRecovery (defensive branches)", () => {
  it.effect(
    "notifyRecoveryByAccountId resolves without error when the account row is missing",
    () =>
      Effect.gen(function* () {
        const auth = createAuthService(baseConfig);
        yield* auth.notifyRecoveryByAccountId("acc_doesnotexist00", "recovery_code_generate");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("notifyRecovery resolves without error when sendEmail is not configured", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig); // no sendEmail
      yield* auth.notifyRecovery("somebody@example.com", "recovery_code_consume");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("notifyRecovery resolves without error when recipient email is null", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      yield* auth.notifyRecovery(null, "recovery_code_generate");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("acknowledgeSecurityEvent (S-M1 step-up gated)", () => {
  it.effect("acking a row with a valid step-up token removes it from the unacked list", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-ack@example.com", "sevack");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events).toHaveLength(1);

      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);
      const result = yield* auth.acknowledgeSecurityEvent(
        profile.accountId,
        events[0]!.id,
        stepUpToken,
      );
      expect(result.acknowledged).toBe(true);

      const after = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(after.events).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects an invalid step-up token with AuthError", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-nostepup@example.com", "sevnostepup");
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);

      const err = yield* Effect.flip(
        auth.acknowledgeSecurityEvent(profile.accountId, events[0]!.id, "not.a.jwt"),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a step-up token issued for a different account", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const owner = yield* registered(auth, "sev-owner2@example.com", "sevowner2");
      const other = yield* registered(auth, "sev-other2@example.com", "sevother2");
      yield* auth.generateRecoveryCodesForAccount(owner.accountId);
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(owner.accountId);

      // Mint a step-up for `other`, then try to use it against `owner`'s event.
      const stepUpToken = yield* mintStepUp(auth, other.accountId, captured);
      const err = yield* Effect.flip(
        auth.acknowledgeSecurityEvent(owner.accountId, events[0]!.id, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("acking a nonexistent id returns { acknowledged: false }", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-miss@example.com", "sevmiss");
      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);

      const result = yield* auth.acknowledgeSecurityEvent(
        profile.accountId,
        "sev_000000000000",
        stepUpToken,
      );
      expect(result.acknowledged).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("acking an id scoped to another account is a no-op (step-up consumed anyway)", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const owner = yield* registered(auth, "sev-owner@example.com", "sevowner");
      const other = yield* registered(auth, "sev-other@example.com", "sevother");

      yield* auth.generateRecoveryCodesForAccount(owner.accountId);
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(owner.accountId);

      // `other` mints their own step-up and tries to ack owner's event. Step-
      // up is for `other`'s account, so the subject check fails before the
      // row lookup — test asserts the cross-account attempt fails at the
      // step-up gate (AuthError), not silently.
      const stepUpToken = yield* mintStepUp(auth, other.accountId, captured);
      const err = yield* Effect.flip(
        auth.acknowledgeSecurityEvent(owner.accountId, events[0]!.id, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");

      // Owner's list is untouched.
      const stillThere = yield* auth.listUnacknowledgedSecurityEvents(owner.accountId);
      expect(stillThere.events).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("malformed ids are rejected after step-up verify without hitting the DB", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-malformed@example.com", "sevmalformed");
      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);

      const result = yield* auth.acknowledgeSecurityEvent(
        profile.accountId,
        "not-a-valid-id",
        stepUpToken,
      );
      expect(result.acknowledged).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("acknowledgeAllSecurityEvents (S-M1 bulk path)", () => {
  it.effect("dismisses every unacked event for the account in one call", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-ackall@example.com", "sevackall");

      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);
      const result = yield* auth.acknowledgeAllSecurityEvents(profile.accountId, stepUpToken);
      expect(result.acknowledged).toBe(3);

      const after = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(after.events).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns { acknowledged: 0 } when there's nothing to dismiss", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const profile = yield* registered(auth, "sev-ackall-empty@example.com", "sevackallempty");
      const stepUpToken = yield* mintStepUp(auth, profile.accountId, captured);
      const result = yield* auth.acknowledgeAllSecurityEvents(profile.accountId, stepUpToken);
      expect(result.acknowledged).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a missing / invalid step-up token", () =>
    Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* registered(auth, "sev-ackall-nostepup@example.com", "sevackallns");
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      const err = yield* Effect.flip(
        auth.acknowledgeAllSecurityEvents(profile.accountId, "not.a.jwt"),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not touch events scoped to another account", () =>
    Effect.gen(function* () {
      const { auth, captured } = makeCapturingAuth();
      const owner = yield* registered(auth, "sev-ownerbulk@example.com", "sevownerbulk");
      const other = yield* registered(auth, "sev-otherbulk@example.com", "sevotherbulk");
      yield* auth.generateRecoveryCodesForAccount(owner.accountId);
      yield* auth.generateRecoveryCodesForAccount(other.accountId);

      const otherStepUp = yield* mintStepUp(auth, other.accountId, captured);
      yield* auth.acknowledgeAllSecurityEvents(other.accountId, otherStepUp);

      const ownerList = yield* auth.listUnacknowledgedSecurityEvents(owner.accountId);
      expect(ownerList.events).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
