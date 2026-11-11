import { it, expect, describe } from "@effect/vitest";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import type { CeremonyStore } from "../../src/lib/ceremony-store";
import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { MAX_OTP_ATTEMPTS, TOTP_MAX_ENROLL_ATTEMPTS } from "../../src/services/auth/constants";
import { createDefaultCeremonyStores, type CeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "../helpers/db";
import { latestLinkTo, registerThroughService } from "../helpers/registration";

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
    recorded: () => email.recorded(),
    latest: (): string => {
      const all = codes();
      if (all.length === 0) throw new Error("no code captured");
      return all.at(-1)!;
    },
    /**
     * The code mailed after `seen` codes had been. A code goes out in the
     * background, so it may land a moment after `begin` answers.
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
    "emailed recovery link: of two polls of a confirmed request at once, exactly one gets the session",
    () => {
      const mail = capture();
      const stores = bundle();
      const auth = createAuthService({ ...base, ...stores });
      return Effect.gen(function* () {
        yield* auth.registerProfile("att-rec2@example.com", "attrec2");
        const begun = yield* settle(auth.beginEmailRecovery("att-rec2@example.com"));
        const link = latestLinkTo(mail.recorded(), "att-rec2@example.com")!;
        expect(
          yield* auth.confirmEmailLink(link.requestId, {
            linkSecret: link.linkSecret,
            pairingPick: begun.pairingCode,
          }),
        ).toBe("confirmed");
        const polls = yield* Effect.all(
          [0, 1].map(() => auth.emailRecoveryStatus(begun.requestId, begun.claimSecret)),
          { concurrency: "unbounded" },
        );
        const statuses = polls.map((p) => p.status).toSorted();
        expect(statuses).toEqual(["complete", "expired"]);
        // The claim took the request: the cooldown alone would also refuse the
        // second poll, so the spent entry is what shows the claim did it.
        expect(
          yield* Effect.promise(() => stores.ceremonyStores.emailLinks.get(begun.requestId)),
        ).toBeNull();
      }).pipe(Effect.provide(mail.layer));
    },
  );

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

  it.live(
    "email change: of two right codes sent at once, each with its own token, exactly one commits",
    () => {
      const mail = capture();
      const auth = createAuthService({ ...base, ...bundle() });
      return Effect.gen(function* () {
        const profile = yield* auth.registerProfile("att-ec2@example.com", "attec2");
        const tokens = yield* Effect.all(
          [0, 1].map(() => auth.issueStepUpToken(profile.accountId, "otp", "email_change")),
        );
        yield* auth.beginEmailChange(profile.accountId, "att-ec2-new@example.com");
        const right = mail.latest();
        const results = yield* Effect.all(
          tokens.map((token) =>
            Effect.result(auth.completeEmailChange(profile.accountId, right, token, null)),
          ),
          { concurrency: "unbounded" },
        );
        const committed = results.filter((r) => r._tag === "Success");
        expect(committed.map((r) => r.success)).toEqual([{ email: "att-ec2-new@example.com" }]);
        const refused = results.filter((r) => r._tag === "Failure");
        expect(refused.map((r) => r.failure._tag)).toEqual(["AuthError"]);
        expect(refused[0]!.failure.message).toMatch(/invalid or expired code/i);
        const rows = mail.sqlite
          .query("SELECT COUNT(*) AS n FROM email_changes WHERE account_id = ?")
          .get(profile.accountId) as { n: number };
        expect(rows.n).toBe(1);
      }).pipe(Effect.provide(mail.layer));
    },
  );

  it.live("registration: a burst of wrong link secrets spends the link; a new one works", () => {
    const mail = capture();
    const auth = createAuthService({ ...base, ...bundle() });
    const address = "att-reg@example.com";
    return Effect.gen(function* () {
      const begun = yield* settle(auth.beginRegistration(address, "attreg", "1990-01-01"));
      const link = latestLinkTo(mail.recorded(), address)!;
      const wrong = { linkSecret: "0".repeat(64), pairingPick: begun.pairingCode };

      yield* Effect.all(
        Array.from({ length: MAX_OTP_ATTEMPTS + BURST }, () =>
          auth.confirmEmailLink(link.requestId, wrong),
        ),
        { concurrency: "unbounded" },
      );

      const late = yield* auth.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });
      expect(late).toBe("expired");

      const done = yield* registerThroughService(auth, mail.recorded, address, "attreg");
      expect(done.handle).toBe("attreg");
    }).pipe(Effect.provide(mail.layer));
  });
});
