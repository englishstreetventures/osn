import { it, expect, describe } from "@effect/vitest";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import type { CeremonyStore } from "../../src/lib/ceremony-store";
import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createInMemoryRecoveryLockoutStore } from "../../src/lib/recovery-lockout-store";
import { createAuthService } from "../../src/services/auth";
import { MAX_OTP_ATTEMPTS, TOTP_MAX_ENROLL_ATTEMPTS } from "../../src/services/auth/constants";
import { createDefaultCeremonyStores, type CeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * Every code-checking ceremony counts its guesses in the store, one atomic
 * read-and-count per guess, before it compares the code. Guesses sent together
 * therefore each take their own place in the count: the guess that reaches
 * the cap burns the entry, every guess after it is refused unread, and the
 * right code cannot be found by sending more guesses at once than the cap.
 *
 * Each case sends the cap plus three wrong guesses at the same moment, then
 * the right code — which must be refused, because the entry is spent — then
 * begins again and shows the new code works at once. Where a right code
 * consumes the entry, a second case sends it twice at once: the slowed reads
 * let both past the entry check, so only the claim can refuse the second.
 *
 * Run on both bundles: the in-memory one and the Durable Object one over a
 * stand-in namespace. Every call that reads an entry answers a few
 * milliseconds late, as a Durable Object round trip does, so the guesses'
 * reads overlap however the rest of each ceremony is scheduled; without that,
 * a test here could pass on code that counts guesses with a read and a write.
 */

const BURST = 3;
const READ_DELAY_MS = 10;

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

/** `run`'s answer, delivered `READ_DELAY_MS` after the store gave it. */
const late = <A>(run: Promise<A>): Promise<A> =>
  run.then((value) => new Promise((resolve) => setTimeout(() => resolve(value), READ_DELAY_MS)));

/** `stores` with every call that reads an entry answering `READ_DELAY_MS` late. */
function slowReads(stores: CeremonyStores): CeremonyStores {
  const out = {} as Record<keyof CeremonyStores, unknown>;
  for (const [name, store] of Object.entries(stores) as [
    keyof CeremonyStores,
    CeremonyStore<unknown>,
  ][]) {
    out[name] = {
      ...store,
      // Read now, answer later: the answer is what the store held when the
      // call arrived, delivered after the round trip.
      get: (key: string) => late(store.get(key)),
      guess: (key: string) => late(store.guess(key)),
      take: (key: string) => late(store.take(key)),
    };
  }
  return out as CeremonyStores;
}

const bundles = {
  memory: () => ({ ceremonyStores: slowReads(createDefaultCeremonyStores()) }),
  durable_object: () => ({
    ceremonyStores: slowReads(
      createDurableCoordination(createFakeNamespace().ns, () => {}).ceremonyStores,
    ),
  }),
} as const;

/** A database, a mail recorder and the latest six-digit code it captured. */
function capture() {
  const email = makeLogEmailLive();
  const db = createTestLayerWithSqlite();
  const codes = () =>
    email.recorded().flatMap((sent) => sent.text.match(/code is: (\d{6})/)?.[1] ?? []);
  return {
    layer: Layer.merge(db.layer, email.layer),
    sqlite: db.sqlite,
    latest: (): string => {
      const all = codes();
      if (all.length === 0) throw new Error("no code captured");
      return all.at(-1)!;
    },
    /**
     * The code mailed after `seen` codes had been. The recovery code goes out
     * in the background, so it may land a moment after `begin` answers.
     */
    nth: (seen: number): Effect.Effect<string> =>
      Effect.gen(function* () {
        for (let i = 0; i < 100; i++) {
          const all = codes();
          if (all.length > seen) return all[seen]!;
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
        }
        throw new Error("no code captured");
      }),
  };
}

/** A six-digit code that is not `right`. */
const wrongFor = (right: string): string => (right === "000000" ? "111111" : "000000");

/** The authenticator code for `secret` now. */
const codeFor = (secret: string) =>
  Effect.promise(() => deriveTotpCode(base32Decode(secret), Math.floor(Date.now() / 1000 / 30)));

describe.each(Object.entries(bundles))("attempt counting on the %s bundle", (_name, bundle) => {
  it.live("step-up OTP: a burst of wrong guesses spends the code; a new one works", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("att-su@example.com", "attsu");
      yield* auth.beginStepUpOtp(profile.accountId);
      const right = mail.latest();

      const guesses = yield* Effect.all(
        Array.from({ length: MAX_OTP_ATTEMPTS + BURST }, () =>
          Effect.flip(auth.completeStepUpOtp(profile.accountId, wrongFor(right))),
        ),
        { concurrency: "unbounded" },
      );
      expect(guesses.every((e) => e._tag === "AuthError")).toBe(true);

      const late = yield* Effect.flip(auth.completeStepUpOtp(profile.accountId, right));
      expect(late._tag).toBe("AuthError");

      yield* auth.beginStepUpOtp(profile.accountId);
      const fresh = yield* auth.completeStepUpOtp(profile.accountId, mail.latest());
      expect(fresh.stepUpToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(mail.layer));
  });

  it.live("step-up OTP: of two right codes sent at once, exactly one mints a token", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("att-su2@example.com", "attsu2");
      yield* auth.beginStepUpOtp(profile.accountId);
      const right = mail.latest();
      const results = yield* Effect.all(
        [0, 1].map(() => Effect.result(auth.completeStepUpOtp(profile.accountId, right))),
        { concurrency: "unbounded" },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
    }).pipe(Effect.provide(mail.layer));
  });

  it.live(
    "emailed recovery code: a burst of wrong guesses spends the code; a new one works",
    () => {
      const mail = capture();
      // The per-account lockout would refuse the right code on its own; lifted
      // out of the way so the attempt count is the only thing that can.
      const auth = createAuthService({
        ...base,
        ...bundle(),
        recoveryOtpLockoutStore: createInMemoryRecoveryLockoutStore({ threshold: 100 }),
      });
      return Effect.gen(function* () {
        yield* auth.registerProfile("att-rec@example.com", "attrec");
        yield* auth.beginEmailRecovery("att-rec@example.com");
        const right = yield* mail.nth(0);

        yield* Effect.all(
          Array.from({ length: MAX_OTP_ATTEMPTS + BURST }, () =>
            Effect.flip(auth.completeEmailRecovery("att-rec@example.com", wrongFor(right))),
          ),
          { concurrency: "unbounded" },
        );

        const late = yield* Effect.flip(auth.completeEmailRecovery("att-rec@example.com", right));
        expect(late._tag).toBe("AuthError");

        yield* auth.beginEmailRecovery("att-rec@example.com");
        const fresh = yield* auth.completeEmailRecovery("att-rec@example.com", yield* mail.nth(1));
        expect(fresh.session.accessToken).toMatch(/^eyJ/);
      }).pipe(Effect.provide(mail.layer));
    },
  );

  it.live("emailed recovery code: of two right codes sent at once, exactly one signs in", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      yield* auth.registerProfile("att-rec2@example.com", "attrec2");
      yield* auth.beginEmailRecovery("att-rec2@example.com");
      const right = yield* mail.nth(0);
      const results = yield* Effect.all(
        [0, 1].map(() => Effect.result(auth.completeEmailRecovery("att-rec2@example.com", right))),
        { concurrency: "unbounded" },
      );
      const signedIn = results.filter((r) => r._tag === "Success");
      expect(signedIn).toHaveLength(1);
      expect(signedIn[0]!.success.session.accessToken).toMatch(/^eyJ/);
      const refused = results.filter((r) => r._tag === "Failure");
      expect(refused.map((r) => r.failure._tag)).toEqual(["AuthError"]);
    }).pipe(Effect.provide(mail.layer));
  });

  it.live("TOTP enrolment: a burst of wrong codes spends the secret; a new one works", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("att-totp@example.com", "atttotp");
      const token = () => auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const first = yield* auth.beginTotpEnrollment(profile.accountId, yield* token());
      const right = yield* codeFor(first.totpSecret);

      yield* Effect.all(
        Array.from({ length: TOTP_MAX_ENROLL_ATTEMPTS + BURST }, () =>
          Effect.flip(auth.completeTotpEnrollment(profile.accountId, wrongFor(right), null)),
        ),
        { concurrency: "unbounded" },
      );

      const late = yield* Effect.flip(auth.completeTotpEnrollment(profile.accountId, right, null));
      expect(late._tag).toBe("AuthError");

      const second = yield* auth.beginTotpEnrollment(profile.accountId, yield* token());
      const done = yield* auth.completeTotpEnrollment(
        profile.accountId,
        yield* codeFor(second.totpSecret),
        null,
      );
      expect(done.enrolled).toBe(true);
    }).pipe(Effect.provide(mail.layer));
  });

  it.live("TOTP enrolment: of two right codes sent at once, exactly one enrols", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("att-totp2@example.com", "atttotp2");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const begun = yield* auth.beginTotpEnrollment(profile.accountId, token);
      const right = yield* codeFor(begun.totpSecret);
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.result(auth.completeTotpEnrollment(profile.accountId, right, null)),
        ),
        { concurrency: "unbounded" },
      );
      const enrolled = results.filter((r) => r._tag === "Success");
      expect(enrolled.map((r) => r.success)).toEqual([{ enrolled: true }]);
      const refused = results.filter((r) => r._tag === "Failure");
      expect(refused.map((r) => r.failure._tag)).toEqual(["AuthError"]);
      const rows = mail.sqlite
        .query("SELECT COUNT(*) AS n FROM totp_credentials WHERE account_id = ?")
        .get(profile.accountId) as { n: number };
      expect(rows.n).toBe(1);
    }).pipe(Effect.provide(mail.layer));
  });

  it.live("email change: a burst of wrong codes spends the code; a new one works", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("att-ec@example.com", "attec");
      // One step-up token per guess: each completion spends its own.
      const tokens = yield* Effect.all(
        Array.from({ length: MAX_OTP_ATTEMPTS + BURST + 2 }, () =>
          auth.issueStepUpToken(profile.accountId, "otp", "email_change"),
        ),
      );
      yield* auth.beginEmailChange(profile.accountId, "att-ec-new@example.com");
      const right = mail.latest();

      yield* Effect.all(
        tokens
          .slice(0, MAX_OTP_ATTEMPTS + BURST)
          .map((t) =>
            Effect.flip(auth.completeEmailChange(profile.accountId, wrongFor(right), t, null)),
          ),
        { concurrency: "unbounded" },
      );

      const late = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, right, tokens.at(-2)!, null),
      );
      expect(late._tag).toBe("AuthError");

      yield* auth.beginEmailChange(profile.accountId, "att-ec-new@example.com");
      const done = yield* auth.completeEmailChange(
        profile.accountId,
        mail.latest(),
        tokens.at(-1)!,
        null,
      );
      expect(done.email).toBe("att-ec-new@example.com");
    }).pipe(Effect.provide(mail.layer));
  });

  it.live("registration: a burst of wrong codes spends the code; a new one works", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    return Effect.gen(function* () {
      yield* settle(auth.beginRegistration("att-reg@example.com", "attreg", "1990-01-01"));
      const right = mail.latest();

      yield* Effect.all(
        Array.from({ length: MAX_OTP_ATTEMPTS + BURST }, () =>
          Effect.flip(auth.completeRegistration("att-reg@example.com", wrongFor(right))),
        ),
        { concurrency: "unbounded" },
      );

      const late = yield* Effect.flip(auth.completeRegistration("att-reg@example.com", right));
      expect(late._tag).toBe("AuthError");

      yield* settle(auth.beginRegistration("att-reg@example.com", "attreg", "1990-01-01"));
      const done = yield* auth.completeRegistration("att-reg@example.com", mail.latest());
      expect(done.handle).toBe("attreg");
    }).pipe(Effect.provide(mail.layer));
  });
});
