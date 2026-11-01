import { it, expect, describe } from "@effect/vitest";
import { securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";

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

  it.live("emailed recovery code", () => {
    const db = auditNeverFinishes();
    const auth = createAuthService(base);
    return Effect.gen(function* () {
      yield* auth.registerProfile("bg-email@example.com", "bgemail");
      // A code pending, so each wrong code is a counted failure on the account.
      yield* auth.beginEmailRecovery("bg-email@example.com");
      db.stall();
      for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD - 1; i++) {
        yield* Effect.result(auth.completeEmailRecovery("bg-email@example.com", "000000"));
      }
      expect(
        yield* refusedPromptly(auth.completeEmailRecovery("bg-email@example.com", "000000")),
      ).toBe("AuthError");
    }).pipe(Effect.provide(db.layer));
  });
});
