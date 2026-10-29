import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace } from "@shared/coordination";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import * as metrics from "../../src/metrics";
import { createAuthService } from "../../src/services/auth";
import { TOTP_LOCKOUT_THRESHOLD } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";

/**
 * The TOTP lockout bounds how many codes are compared per account per window,
 * however many attempts arrive at once. Each attempt's lockout call is held
 * until every attempt has sent one, then let go in the order they were sent —
 * the worst case for a counter that is read before it is counted. A right code
 * sent behind the threshold's worth of wrong ones must be refused unread.
 */

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;

/** `ns` with every `totp_lockout` call held, once armed, until `release()`; `sent` counts them. */
function holdingLockout(ns: CoordinationNamespace) {
  let armed = false;
  let sent = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: CoordinationNamespace = {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      const held = name.startsWith("totp_lockout:");
      const call = <A>(run: () => Promise<A>): Promise<A> => {
        if (!armed || !held) return run();
        sent += 1;
        return gate.then(run);
      };
      return {
        increment: (windowMs) => call(() => stub.increment(windowMs)),
        count: () => call(() => stub.count()),
        read: () => call(() => stub.read()),
        write: (value, ttlMs) => call(() => stub.write(value, ttlMs)),
        remove: () => call(() => stub.remove()),
        claim: (ttlMs) => call(() => stub.claim(ttlMs)),
        guess: () => call(() => stub.guess()),
        take: () => call(() => stub.take()),
        swap: (expected, value, ttlMs) => call(() => stub.swap(expected, value, ttlMs)),
      };
    },
  };
  return {
    ns: wrapped,
    arm: () => {
      armed = true;
    },
    sent: () => sent,
    release: () => release(),
  };
}

/** Waits until `count()` reaches `n`. */
const reached = (count: () => number, n: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (count() >= n) return;
      yield* Effect.sleep("5 millis");
    }
    throw new Error(`only ${count()} of ${n} lockout calls were sent`);
  });

describe("a burst of TOTP attempts compares at most the threshold's worth of codes", () => {
  for (const scope of ["step_up", "recovery"] as const) {
    it.live(`${scope}: a right code sent behind the threshold's wrong ones is refused`, () => {
      const fake = createFakeNamespace();
      const gate = holdingLockout(fake.ns);
      const bundle = createDurableCoordination(gate.ns, () => {});
      const auth = createAuthService({
        ...base,
        ceremonyStores: bundle.ceremonyStores,
        totpLockoutStore: bundle.totpLockoutStore,
      });
      const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);
      const verified = vi.spyOn(metrics, "metricTotpVerified");
      return Effect.gen(function* () {
        const handle = `race${scope.replace("_", "")}`;
        const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
        const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
        const { totpSecret } = yield* auth.beginTotpEnrollment(profile.accountId, token);
        const secret = base32Decode(totpSecret);
        const step = Math.floor(Date.now() / 1000 / STEP_SECONDS);
        const enrolCode = yield* Effect.promise(() => deriveTotpCode(secret, step));
        yield* auth.completeTotpEnrollment(profile.accountId, enrolCode, "Test phone");
        // The next step's code: inside the drift window, and not yet used.
        const right = yield* Effect.promise(() => deriveTotpCode(secret, step + 1));
        const accepted = new Set(
          yield* Effect.promise(() =>
            Promise.all([-1, 0, 1, 2].map((d) => deriveTotpCode(secret, step + d))),
          ),
        );
        let n = 0;
        while (accepted.has(String(n).padStart(6, "0"))) n += 1;
        const wrong = String(n).padStart(6, "0");

        const attempt = (code: string) =>
          scope === "step_up"
            ? Effect.asVoid(auth.completeStepUpTotp(profile.accountId, code))
            : Effect.asVoid(auth.completeTotpRecovery(handle, code));

        verified.mockClear();
        gate.arm();
        const wrongCount = TOTP_LOCKOUT_THRESHOLD * 2 - 1;
        const wrongs: Fiber.Fiber<unknown, unknown>[] = [];
        for (let i = 0; i < wrongCount; i++) {
          wrongs.push(yield* Effect.forkChild(Effect.result(attempt(wrong))));
        }
        yield* reached(gate.sent, wrongCount);
        const last = yield* Effect.forkChild(Effect.result(attempt(right)));
        yield* reached(gate.sent, wrongCount + 1);
        gate.release();

        const outcomes = [];
        for (const fiber of [...wrongs, last]) outcomes.push(yield* Fiber.join(fiber));
        expect(outcomes.map((o) => (o as { _tag: string })._tag)).toEqual(
          Array.from({ length: wrongCount + 1 }, () => "Failure"),
        );
        const results = verified.mock.calls.map(([result]) => result);
        expect(results.filter((r) => r !== "locked_out")).toHaveLength(TOTP_LOCKOUT_THRESHOLD);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => verified.mockRestore())));
    });
  }
});
