import { it, expect, describe } from "@effect/vitest";
import { securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createTestLayerWithSqlite } from "../helpers/db";
import { latestLinkTo } from "../helpers/registration";

/**
 * Only a real account can cross a lockout threshold, and crossing it writes an
 * audit row. If the refusal waited on that write, the guess that crosses the
 * threshold would answer measurably later than the guesses before it — and
 * than any guess at an address that names nobody — so a list of addresses
 * could be sorted into real and not by timing the fifth wrong code. The row is
 * written after the answer, in the background.
 *
 * Each case makes the audit insert never finish, then requires the crossing
 * guess to answer within a second all the same.
 */

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

/** A database whose `security_events` inserts never settle; everything else is real. */
function auditNeverFinishes() {
  const { db } = createTestLayerWithSqlite();
  let hanging = false;
  const stalled = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) =>
          hanging && table === securityEvents
            ? { values: () => new Promise<never>(() => {}) }
            : target.insert(table as never);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(Layer.succeed(Db, { db: stalled }), email.layer),
    email,
    stall: () => {
      hanging = true;
    },
  };
}

/** `run` must fail with the generic refusal inside a second. */
const refusedPromptly = <A, E extends { readonly _tag: string }, R>(run: Effect.Effect<A, E, R>) =>
  run.pipe(
    Effect.timeout("1 second"),
    Effect.flip,
    Effect.map((error) => error._tag),
  );

describe("the guess that crosses a lockout threshold answers without its audit row", () => {
  it.live("recovery code", () => {
    const db = auditNeverFinishes();
    const auth = createAuthService(base);
    return Effect.gen(function* () {
      yield* auth.registerProfile("bg-code@example.com", "bgcode");
      db.stall();
      for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD - 1; i++) {
        yield* Effect.result(auth.consumeRecoveryCode("bgcode", "wrong-code"));
      }
      expect(yield* refusedPromptly(auth.consumeRecoveryCode("bgcode", "wrong-code"))).toBe(
        "AuthError",
      );
    }).pipe(Effect.provide(db.layer));
  });

  it.live("emailed recovery link", () => {
    const db = auditNeverFinishes();
    const auth = createAuthService(base);
    return Effect.gen(function* () {
      yield* auth.registerProfile("bg-email@example.com", "bgemail");
      // A request per wrong number, each mailed: a wrong number ends its request.
      const requests = [];
      for (let n = 0; n < RECOVERY_LOCKOUT_THRESHOLD; n++) {
        const begun = yield* settle(
          auth.beginEmailRecovery("bg-email@example.com", { ip: `198.51.100.${n}`, uaLabel: null }),
        );
        const link = latestLinkTo(db.email.recorded(), "bg-email@example.com")!;
        requests.push({ begun, link });
      }
      const wrongFor = (right: string) => (right === "00" ? "01" : "00");
      db.stall();
      for (const { begun, link } of requests.slice(0, -1)) {
        const answer = yield* auth.confirmEmailLink(begun.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: wrongFor(begun.pairingCode),
        });
        expect(answer).toBe("expired");
      }
      // A wrong number answers `expired` rather than failing, so the crossing
      // one is timed as an answer within the second.
      const last = requests.at(-1)!;
      const crossing = yield* auth
        .confirmEmailLink(last.begun.requestId, {
          linkSecret: last.link.linkSecret,
          pairingPick: wrongFor(last.begun.pairingCode),
        })
        .pipe(Effect.timeout("1 second"));
      expect(crossing).toBe("expired");
    }).pipe(Effect.provide(db.layer));
  });
  it.live("emailed step-up link", () => {
    const db = auditNeverFinishes();
    const auth = createAuthService(base);
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("bg-stepup@example.com", "bgstepup");
      // A request per wrong number, each mailed: a wrong number ends its request.
      const requests = [];
      for (let n = 0; n < RECOVERY_LOCKOUT_THRESHOLD; n++) {
        const begun = yield* settle(
          auth.beginStepUpEmail(profile.accountId, "account_export", {
            ip: `198.51.100.${n}`,
            uaLabel: null,
          }),
        );
        const link = latestLinkTo(db.email.recorded(), "bg-stepup@example.com")!;
        requests.push({ begun, link });
      }
      const wrongFor = (right: string) => (right === "00" ? "01" : "00");
      db.stall();
      for (const { begun, link } of requests.slice(0, -1)) {
        const answer = yield* auth.confirmEmailLink(begun.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: wrongFor(begun.pairingCode),
        });
        expect(answer).toBe("expired");
      }
      const last = requests.at(-1)!;
      const crossing = yield* auth
        .confirmEmailLink(last.begun.requestId, {
          linkSecret: last.link.linkSecret,
          pairingPick: wrongFor(last.begun.pairingCode),
        })
        .pipe(Effect.timeout("1 second"));
      expect(crossing).toBe("expired");
    }).pipe(Effect.provide(db.layer));
  });

  it.live("a declined step-up link", () => {
    const db = auditNeverFinishes();
    const auth = createAuthService(base);
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("bg-stepdecline@example.com", "bgstepdecline");
      const begun = yield* settle(auth.beginStepUpEmail(profile.accountId, "account_export"));
      const link = latestLinkTo(db.email.recorded(), "bg-stepdecline@example.com")!;
      db.stall();
      const answer = yield* auth
        .confirmEmailLink(begun.requestId, { linkSecret: link.linkSecret, pairingPick: "none" })
        .pipe(Effect.timeout("1 second"));
      expect(answer).toBe("declined");
    }).pipe(Effect.provide(db.layer));
  });
});
