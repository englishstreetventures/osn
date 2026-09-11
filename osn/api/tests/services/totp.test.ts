import { it, expect, describe } from "@effect/vitest";
import { totpCredentials } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { createInMemoryRecoveryLockoutStore } from "../../src/lib/recovery-lockout-store";
import {
  createTotpKeyRing,
  decryptTotpSecret,
  generateEphemeralTotpEncryptionKey,
  TOTP_KEY_VERSION,
  type TotpKeyRing,
} from "../../src/lib/totp-secret-crypto";
import * as metrics from "../../src/metrics";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { TOTP_LOCKOUT_THRESHOLD } from "../../src/services/auth/constants";
import { createDefaultCeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";

/**
 * The TOTP credential's own behaviour. What matters here and is easy to get
 * wrong:
 *
 *   • an accepted code is single use (RFC 6238 §5.2), INCLUDING the one typed
 *     into the enrolment form, and including two submissions racing;
 *   • the next step's code still works, which is the whole reason
 *     `verifyTotpCode` returns the matched step rather than a boolean;
 *   • every failure looks identical on the wire;
 *   • the per-account lockout fails CLOSED, unlike its recovery-code sibling;
 *   • enrolment and disable each leave an audit row and send a notice;
 *   • which step-up verifiers a `totp` AMR reaches, and which refuse it.
 */

let config: AuthConfig;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const STEP_SECONDS = 30;

function makeLayer() {
  const email = makeLogEmailLive();
  return Layer.merge(createTestLayer(), email.layer);
}

/**
 * Wrap a drizzle query builder so it does not execute until `delayMs` has
 * passed. Builders are thenable and chain by returning more builders, so every
 * method is proxied and `then` — the one point where the statement actually
 * runs — is what gets deferred.
 */
function delayChain(node: object, delayMs: number): object {
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          new Promise((resolve) => setTimeout(resolve, delayMs))
            .then(() =>
              (value as (...a: unknown[]) => unknown).call(target, (real: unknown) => real),
            )
            .then(onFulfilled, onRejected);
      }
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out !== null && typeof out === "object" ? delayChain(out, delayMs) : out;
      };
    },
  });
}

/**
 * A layer whose UPDATE statements land a few milliseconds after they are
 * issued. SELECTs are untouched, and everything still runs for real against
 * the in-memory SQLite.
 *
 * The gap between reading a row and writing it back is the entire subject of
 * `consumeStep`, and in a deployed tier that gap is a network round trip to
 * D1 — ample time for a second request to read the same row. On bun:sqlite it
 * is a couple of microtasks, and measurably too short: two fibres started
 * together still run one at a time through the consume, so an unmodified
 * in-memory run cannot tell a conditional UPDATE from a read-then-write and a
 * concurrency test over it passes under both. Deferring the write restores the
 * production timing rather than inventing a race that could not happen.
 */
function makeSlowUpdateLayer(delayMs = 20) {
  const real = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* Db;
      }),
      createTestLayer(),
    ),
  ).db;
  const proxied = new Proxy(real as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "update" && typeof value === "function") {
        return (...args: unknown[]) =>
          delayChain((value as (...a: unknown[]) => object).apply(target, args), delayMs);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof real;
  return Layer.merge(Layer.succeed(Db, { db: proxied }), makeLogEmailLive().layer);
}

/**
 * Register an account and put a confirmed TOTP credential on it, using the
 * given service.
 *
 * Parameterised because a key rotation is a service that comes back with a
 * different ring: those tests have to enrol under one and verify under
 * another, and the module-level `auth` is built once in `beforeAll`.
 */
const enrolledWith = (
  service: ReturnType<typeof createAuthService>,
  emailAddr: string,
  handle: string,
) =>
  Effect.gen(function* () {
    const profile = yield* service.registerProfile(emailAddr, handle);
    const stepUpToken = yield* service.issueStepUpToken(
      profile.accountId,
      "passkey",
      "totp_enroll",
    );
    const { totpSecret, otpauthUri } = yield* service.beginTotpEnrollment(
      profile.accountId,
      stepUpToken,
    );
    const secret = base32Decode(totpSecret);
    const code = yield* Effect.promise(() =>
      deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)),
    );
    yield* service.completeTotpEnrollment(profile.accountId, code, "Test phone");
    return { profile, secret, otpauthUri, enrolmentCode: code };
  });

/** The same, on the shared service every non-rotation test uses. */
const enrolled = (emailAddr: string, handle: string) => enrolledWith(auth, emailAddr, handle);

const codeAtStep = (secret: Uint8Array, step: number) =>
  Effect.promise(() => deriveTotpCode(secret, step));

const currentStep = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);

/**
 * Move the wall clock on by one TOTP step.
 *
 * Only `Date` is faked — `setTimeout` stays real, so Effect's scheduler is
 * untouched. This is the honest way to test successive ceremonies: a code two
 * steps ahead of now is OUTSIDE the ±1 drift window and is supposed to be
 * refused, so "the next code still works" can only be shown by letting time
 * pass, not by reaching further up the counter.
 */
const advanceOneStep = () => {
  vi.setSystemTime(new Date(Date.now() + STEP_SECONDS * 1000));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("TOTP enrolment", () => {
  it.effect("enrols, and status reports it without any secret material", () =>
    Effect.gen(function* () {
      const { profile, otpauthUri } = yield* enrolled("totp-a@example.com", "totpa");

      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(true);
      expect(status.label).toBe("Test phone");

      // Assert the WHOLE body, not a field: a future column added to the
      // projection would otherwise ship silently.
      expect(Object.keys(status).toSorted()).toEqual([
        "createdAt",
        "enrolled",
        "label",
        "lastUsedAt",
      ]);
      expect(JSON.stringify(status)).not.toContain("otpauth");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses enrolment without a step-up token minted for it", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-b@example.com", "totpb");
      // A real step-up token, but minted for a DIFFERENT ceremony. Purpose
      // binding, not the AMR list, is what stops this.
      const wrongPurpose = yield* auth.issueStepUpToken(
        profile.accountId,
        "passkey",
        "passkey_register",
      );
      const err = yield* Effect.flip(auth.beginTotpEnrollment(profile.accountId, wrongPurpose));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a second credential while one is confirmed", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-c@example.com", "totpc");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const err = yield* Effect.flip(auth.beginTotpEnrollment(profile.accountId, token));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a wrong code at enroll/complete", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-d@example.com", "totpd");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      yield* auth.beginTotpEnrollment(profile.accountId, token);

      const err = yield* Effect.flip(
        auth.completeTotpEnrollment(profile.accountId, "000000", null),
      );
      expect(err._tag).toBe("AuthError");

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses enroll/complete when no enrolment is pending", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-e@example.com", "totpe");
      const err = yield* Effect.flip(
        auth.completeTotpEnrollment(profile.accountId, "123456", null),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP single use (RFC 6238 §5.2)", () => {
  it.effect("accepts a code once and refuses the same code again", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-f@example.com", "totpf");
      // A later step than the enrolment consumed, so this is a clean first use.
      const step = currentStep() + 1;
      const code = yield* codeAtStep(secret, step);

      const first = yield* auth.completeStepUpTotp(profile.accountId, code);
      expect(first.stepUpToken).toMatch(/^eyJ/);

      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, code));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses the enrolment code itself at step-up", () =>
    Effect.gen(function* () {
      // The enrolment code is a real code and the most-observed one the
      // credential will ever produce — it is typed into a form. If the row went
      // in with a null step it would stay replayable for the rest of its window.
      const { profile, enrolmentCode } = yield* enrolled("totp-g@example.com", "totpg");
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, enrolmentCode));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a code from a step at or below the last accepted one", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-h@example.com", "totph");
      const step = currentStep() + 1;
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, step));

      // The previous step is still inside the ±1 drift window, so it verifies
      // arithmetically — only the stored step rejects it.
      const older = yield* codeAtStep(secret, step - 1);
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, older));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still accepts the NEXT step's code straight after a success", () =>
    Effect.gen(function* () {
      // This is the case the boolean-returning alternative would have broken:
      // refusing every code for the rest of the drift window would fail a
      // legitimate second ceremony ~90 seconds later.
      const { profile, secret } = yield* enrolled("totp-i@example.com", "totpi");

      vi.useFakeTimers({ toFake: ["Date"] });
      advanceOneStep();
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, currentStep()));

      advanceOneStep();
      const next = yield* auth.completeStepUpTotp(
        profile.accountId,
        yield* codeAtStep(secret, currentStep()),
      );
      expect(next.stepUpToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("lets exactly ONE of two concurrent submissions of the same code through", () =>
    Effect.gen(function* () {
      // The claim `consumeStep` is written for, and the only test here that can
      // see it. Every other single-use test submits sequentially, where a
      // SELECT-then-UPDATE rejects the second attempt just as well — so none of
      // them can tell the two implementations apart.
      //
      // The write is deferred (see `makeSlowUpdateLayer`) so the second fibre
      // reads the row while the first fibre's write is still in flight, which
      // is the ordinary case against D1 and the one the docstring is about.
      // A read-then-write lets both through here; the conditional UPDATE means
      // the loser changes zero rows and is rejected as a replay.
      const { profile, secret } = yield* enrolled("totp-cc@example.com", "totpcc");
      const code = yield* codeAtStep(secret, currentStep() + 1);

      const outcomes = yield* Effect.all(
        [
          Effect.result(auth.completeStepUpTotp(profile.accountId, code)),
          Effect.result(auth.completeStepUpTotp(profile.accountId, code)),
        ],
        { concurrency: "unbounded" },
      );

      expect(outcomes.filter((o) => o._tag === "Success")).toHaveLength(1);
    }).pipe(Effect.provide(makeSlowUpdateLayer())),
  );
});

/**
 * Key rotation, which is the whole of `xchromo/osn#968`.
 *
 * What is under test is not "two keys can coexist" — it is that an operator can
 * move every credential from one key to another **with no downtime and no
 * re-enrolment**, by writing two Worker secrets some time apart and deleting
 * one of them later. So these build their own `AuthConfig`s: the module-level
 * `auth` is created once in `beforeAll`, and a rotation is precisely a service
 * that comes back with a different ring.
 */
describe("TOTP encryption-key rotation", () => {
  const authWith = (ring: TotpKeyRing) =>
    createAuthService({ ...config, totpEncryptionKeys: ring });

  const credentialRow = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(totpCredentials).where(eq(totpCredentials.accountId, accountId)),
      );
      const row = rows[0];
      if (!row) throw new Error("no credential row");
      return row;
    });

  it.effect("a row written under the old key still verifies once that key is demoted", () => {
    const rekeySpy = vi.spyOn(metrics, "metricTotpRekeyed");
    return Effect.gen(function* () {
      // Issue #968's first two "done when" clauses, in the order an operator
      // meets them: enrol under one key; come back with that key demoted to
      // OSN_TOTP_ENCRYPTION_KEY_PREVIOUS and a new one installed; verify.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);

      const before = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(before, "rot-a@example.com", "rota");
      const original = yield* credentialRow(profile.accountId);
      expect(original.keyVersion).toBe(TOTP_KEY_VERSION);

      const during = authWith(createTotpKeyRing(k2, k1));
      const code = yield* codeAtStep(secret, currentStep() + 1);
      rekeySpy.mockClear();
      yield* during.completeStepUpTotp(profile.accountId, code);

      // Re-keyed: the stamp moved AND the ciphertext really changed. Asserting
      // only the stamp would pass on an implementation that renumbered the row
      // without re-encrypting it — the bug that destroys the credential the
      // moment the old key is deleted.
      const rekeyed = yield* credentialRow(profile.accountId);
      expect(rekeyed.keyVersion).toBe(TOTP_KEY_VERSION + 1);
      expect(
        Buffer.from(rekeyed.secretCiphertext).equals(Buffer.from(original.secretCiphertext)),
      ).toBe(false);

      // The runbook's §10.3 drain gate reads exactly this metric. A swapped
      // literal here would make a healthy rotation look stuck, or a stuck one
      // look healthy, and no other assertion in this file would catch it.
      expect(rekeySpy).toHaveBeenCalledTimes(1);
      expect(rekeySpy).toHaveBeenCalledWith("ok");

      // And now the old key can go, which is the point of the whole exercise.
      // The clock has to move: the step just spent is gone, and a code two
      // steps ahead is outside the +/-1 drift window and would be refused for a
      // reason that has nothing to do with rotation.
      advanceOneStep();
      const after = authWith(createTotpKeyRing(k2));
      const next = yield* codeAtStep(secret, currentStep() + 1);
      yield* after.completeStepUpTotp(profile.accountId, next);
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(Effect.sync(() => rekeySpy.mockRestore())),
    );
  });

  it.effect("re-keys once and then leaves the row alone", () =>
    Effect.gen(function* () {
      // A rewrite-on-every-verify implementation passes the test above. It
      // fails this one, and in production it would re-encrypt every credential
      // on every step-up for ever.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const settled = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(settled, "rot-b@example.com", "rotb");

      const before = yield* credentialRow(profile.accountId);
      yield* settled.completeStepUpTotp(
        profile.accountId,
        yield* codeAtStep(secret, currentStep() + 1),
      );
      const after = yield* credentialRow(profile.accountId);

      expect(Buffer.from(after.secretCiphertext).equals(Buffer.from(before.secretCiphertext))).toBe(
        true,
      );
      expect(after.keyVersion).toBe(before.keyVersion);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "a fresh enrolment born under a two-key ring is not rekeyed on its first verify",
    () => {
      const rekeySpy = vi.spyOn(metrics, "metricTotpRekeyed");
      return Effect.gen(function* () {
        // The "new enrolment during a draining rotation" case: a user who
        // enrols WHILE a rotation is in progress does so directly under the
        // two-key ring, so the fresh row is born at the CURRENT slot and never
        // needed a rekey to reach it. `needsRekey` has to compare against the
        // version that actually opened the row, not merely "is this ring
        // mid-rotation" (`ring.size > 1`) — a drain window is however long the
        // least active user takes, and every verify in it would otherwise
        // rewrite ciphertext that was already correct.
        const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
        const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
        const during = authWith(createTotpKeyRing(k2, k1));
        const { profile, secret } = yield* enrolledWith(during, "rot-i@example.com", "roti");

        const original = yield* credentialRow(profile.accountId);
        expect(original.keyVersion).toBe(TOTP_KEY_VERSION + 1);

        rekeySpy.mockClear();
        const code = yield* codeAtStep(secret, currentStep() + 1);
        yield* during.completeStepUpTotp(profile.accountId, code);

        const after = yield* credentialRow(profile.accountId);
        expect(after.keyVersion).toBe(original.keyVersion);
        expect(
          Buffer.from(after.secretCiphertext).equals(Buffer.from(original.secretCiphertext)),
        ).toBe(true);
        expect(Buffer.from(after.iv).equals(Buffer.from(original.iv))).toBe(true);
        expect(rekeySpy).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(makeLayer()),
        Effect.ensuring(Effect.sync(() => rekeySpy.mockRestore())),
      );
    },
  );

  it.effect(
    "stamps a fresh enrolment with the version that OPENED its secret, not the one parked beside it",
    () =>
      Effect.gen(function* () {
        // The parked number and the real answer can disagree when the
        // rotation this credential was born into finishes while the
        // enrolment is still parked. `beginTotpEnrollment` encrypts under
        // whatever key is CURRENT at that moment: while paired with an
        // outgoing key (a rotation still draining) that key sits at slot 2.
        // `completeTotpEnrollment` must stamp the row with the version that
        // OPENED the parked secret — never the parked number — because by
        // the time it runs the operator may have finished that same
        // rotation (§10.4: delete the outgoing key, redeploy), and a lone
        // current key always renumbers to `TOTP_KEY_VERSION`. Ten minutes
        // (the enrolment TTL) is ample time for both to happen. See the
        // comment on `completeTotpEnrollment`'s insert in totp.ts.
        //
        // The store is shared explicitly (`ceremonyStores`) because it is
        // Redis-backed in production: both requests reach the same pending
        // enrolment regardless of which ring the isolate that served them
        // was running. `authWith` does not share it — each call builds a
        // config with no `ceremonyStores` override, so `createAuthContext`
        // would hand each service its own in-memory store and `complete`
        // would never see what `begin` parked.
        const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey); // the outgoing key
        const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey); // the key the row is really under, throughout
        const ceremonyStores = createDefaultCeremonyStores();

        // begin(): the rotation is still draining — k2 is CURRENT (slot 2),
        // k1 is PREVIOUS (slot 1). The secret is encrypted under k2 and
        // parked with keyVersion 2.
        const before = createAuthService({
          ...config,
          totpEncryptionKeys: createTotpKeyRing(k2, k1),
          ceremonyStores,
        });
        const profile = yield* before.registerProfile("rot-h@example.com", "roth");
        const stepUpToken = yield* before.issueStepUpToken(
          profile.accountId,
          "passkey",
          "totp_enroll",
        );
        const { totpSecret } = yield* before.beginTotpEnrollment(profile.accountId, stepUpToken);
        const secret = base32Decode(totpSecret);

        // complete(): the operator finished the rotation in between — k1 is
        // deleted, and k2 is now the LONE key, renumbered to slot 1.
        const during = createAuthService({
          ...config,
          totpEncryptionKeys: createTotpKeyRing(k2),
          ceremonyStores,
        });
        const code = yield* codeAtStep(secret, currentStep());
        yield* during.completeTotpEnrollment(profile.accountId, code, "Test phone");

        const row = yield* credentialRow(profile.accountId);
        // The version that actually opens the row under the ring it was born
        // into — NOT `TOTP_KEY_VERSION + 1`, the number parked while k2 was
        // still paired.
        expect(row.keyVersion).toBe(TOTP_KEY_VERSION);

        const opened = yield* Effect.promise(() =>
          decryptTotpSecret(createTotpKeyRing(k2), profile.accountId, {
            secretCiphertext: row.secretCiphertext,
            iv: row.iv,
            keyVersion: row.keyVersion,
          }),
        );
        expect(opened.secret).toEqual(secret);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("verifies a row whose stamp names no configured key", () =>
    Effect.gen(function* () {
      // The stamp is a hint, not the selector. Between the two secret writes a
      // row's stamp and the key it is really under disagree, and refusing on
      // the stamp would lock out every user in that window.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const service = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(service, "rot-c@example.com", "rotc");

      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(totpCredentials)
          .set({ keyVersion: 99 })
          .where(eq(totpCredentials.accountId, profile.accountId)),
      );

      const before = yield* credentialRow(profile.accountId);
      const code = yield* codeAtStep(secret, currentStep() + 1);
      yield* service.completeStepUpTotp(profile.accountId, code);

      // The stamp is left as it is, deliberately. The row is already under the
      // current key, and rewriting it to correct a number nothing reads would
      // re-encrypt the whole population once after the outgoing key is deleted
      // — and would bounce rows between two isolates still holding different
      // rings, since a secret change does not cycle warm ones.
      const row = yield* credentialRow(profile.accountId);
      expect(row.keyVersion).toBe(99);
      expect(Buffer.from(row.secretCiphertext).equals(Buffer.from(before.secretCiphertext))).toBe(
        true,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("answers the GENERIC failure when no configured key opens the row", () =>
    Effect.gen(function* () {
      // This was a DatabaseError, and so a 500 while every other TOTP failure
      // answers 400 — which told an unauthenticated caller at
      // POST /login/recovery/totp/complete that the account HAS a credential. A
      // mis-staged rotation makes that branch common, so it has to look like
      // every other rejection.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);

      const before = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(before, "rot-d@example.com", "rotd");

      // The operator installed the new key without staging the old one.
      const broken = authWith(createTotpKeyRing(k2));
      const code = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(broken.completeStepUpTotp(profile.accountId, code));

      expect(err._tag).toBe("AuthError");
      const wrong = yield* Effect.flip(broken.completeStepUpTotp(profile.accountId, "000000"));
      expect(err.message).toBe(wrong.message);

      // Nothing was written: an unreadable row never reaches `consumeStep`.
      const row = yield* credentialRow(profile.accountId);
      expect(row.keyVersion).toBe(TOTP_KEY_VERSION);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("verifies even when the re-encryption itself fails", () => {
    const rekeySpy = vi.spyOn(metrics, "metricTotpRekeyed");
    return Effect.gen(function* () {
      // A user who presented a correct code has authenticated. Turning that
      // into a rejection because a housekeeping re-encryption failed would be a
      // self-inflicted lockout during the very incident the drain exists for.
      //
      // The fault is real rather than mocked: the ring's current key is
      // generated with "decrypt" usage only, so `crypto.subtle.encrypt` throws
      // an InvalidAccessError. It cannot pass for the wrong reason — a ring
      // whose DECRYPT also failed would fail the verify outright, which is what
      // the test above asserts.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const decryptOnly = (yield* Effect.promise(() =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["decrypt"]),
      )) as CryptoKey;

      const before = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(before, "rot-e@example.com", "rote");
      const original = yield* credentialRow(profile.accountId);

      const during = authWith(createTotpKeyRing(decryptOnly, k1));
      const code = yield* codeAtStep(secret, currentStep() + 1);
      rekeySpy.mockClear();
      yield* during.completeStepUpTotp(profile.accountId, code);

      // Verified, and the row is untouched rather than half-written.
      const after = yield* credentialRow(profile.accountId);
      expect(after.keyVersion).toBe(TOTP_KEY_VERSION);
      expect(
        Buffer.from(after.secretCiphertext).equals(Buffer.from(original.secretCiphertext)),
      ).toBe(true);
      // The step was still consumed, so single use is unaffected.
      expect(after.lastUsedStep).not.toBe(original.lastUsedStep);

      // The other half of the §10.3 drain gate: a stuck rotation must be
      // reported as stuck, not silently swallowed into "ok".
      expect(rekeySpy).toHaveBeenCalledTimes(1);
      expect(rekeySpy).toHaveBeenCalledWith("failed");
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(Effect.sync(() => rekeySpy.mockRestore())),
    );
  });

  it.effect("a rejected code never rewrites the credential", () =>
    Effect.gen(function* () {
      // The re-encryption rides the statement that CLAIMS the step, so a
      // submission that fails to claim one must leave the row exactly as it
      // was. Moving the rewrite anywhere before that claim would let a replayed
      // or wrong code re-encrypt the credential — writes an attacker can drive
      // at will, against a row nobody authenticated for.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);

      const before = authWith(createTotpKeyRing(k1));
      const { profile, enrolmentCode } = yield* enrolledWith(before, "rot-g@example.com", "rotg");
      const original = yield* credentialRow(profile.accountId);
      expect(original.keyVersion).toBe(TOTP_KEY_VERSION);

      // The enrolment code is arithmetically correct and ALREADY SPENT, and the
      // row is still on the old key — so this is the one submission that both
      // wants a re-key and must not get one. Replaying a code after the row has
      // drained would prove nothing: there would be no re-key left to suppress.
      const during = authWith(createTotpKeyRing(k2, k1));
      yield* Effect.flip(during.completeStepUpTotp(profile.accountId, enrolmentCode));
      yield* Effect.flip(during.completeStepUpTotp(profile.accountId, "000000"));

      const after = yield* credentialRow(profile.accountId);
      expect(
        Buffer.from(after.secretCiphertext).equals(Buffer.from(original.secretCiphertext)),
      ).toBe(true);
      expect(Buffer.from(after.iv).equals(Buffer.from(original.iv))).toBe(true);
      expect(after.keyVersion).toBe(TOTP_KEY_VERSION);
      expect(after.lastUsedStep).toBe(original.lastUsedStep);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps single use when the same statement also re-encrypts", () =>
    Effect.gen(function* () {
      // The re-encryption rides the conditional UPDATE that enforces RFC 6238
      // §5.2. If adding it turned that into a read-then-write, both fibres
      // would pass here — which is what `makeSlowUpdateLayer` exists to expose,
      // since it defers only the write.
      const k1 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);
      const k2 = yield* Effect.promise(generateEphemeralTotpEncryptionKey);

      const before = authWith(createTotpKeyRing(k1));
      const { profile, secret } = yield* enrolledWith(before, "rot-f@example.com", "rotf");

      const during = authWith(createTotpKeyRing(k2, k1));
      const code = yield* codeAtStep(secret, currentStep() + 1);
      const outcomes = yield* Effect.all(
        [
          Effect.result(during.completeStepUpTotp(profile.accountId, code)),
          Effect.result(during.completeStepUpTotp(profile.accountId, code)),
        ],
        { concurrency: "unbounded" },
      );

      expect(outcomes.filter((o) => o._tag === "Success")).toHaveLength(1);

      // And the row that survived the race is coherent: the winner's ciphertext
      // and its version stamp moved together, so it still opens.
      const row = yield* credentialRow(profile.accountId);
      expect(row.keyVersion).toBe(TOTP_KEY_VERSION + 1);
      const opened = yield* Effect.promise(() =>
        decryptTotpSecret(createTotpKeyRing(k2), profile.accountId, {
          secretCiphertext: row.secretCiphertext,
          iv: row.iv,
          keyVersion: row.keyVersion,
        }),
      );
      expect(opened.secret).toEqual(secret);
    }).pipe(Effect.provide(makeSlowUpdateLayer())),
  );
});

describe("TOTP failures are indistinguishable on the wire", () => {
  it.effect("answers the same message for a wrong code and for no credential", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-j@example.com", "totpj");
      const noTotp = yield* auth.registerProfile("totp-k@example.com", "totpk");

      const wrong = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      const absent = yield* Effect.flip(auth.completeStepUpTotp(noTotp.accountId, "000000"));

      expect(wrong.message).toBe(absent.message);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("answers that same message for a replayed code", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-l@example.com", "totpl");
      const step = currentStep() + 1;
      const code = yield* codeAtStep(secret, step);
      yield* auth.completeStepUpTotp(profile.accountId, code);

      const replayed = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, code));
      const wrong = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      expect(replayed.message).toBe(wrong.message);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP per-account lockout", () => {
  it.effect("blocks even a CORRECT code once the threshold is crossed", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-m@example.com", "totpm");

      for (let i = 0; i < TOTP_LOCKOUT_THRESHOLD; i++) {
        yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      }

      // The right code, refused: the lockout is keyed on the account, so a
      // rotating fleet cannot spread the guesses past it.
      const good = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, good));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("clears the counter after a success", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-n@example.com", "totpn");

      for (let i = 0; i < TOTP_LOCKOUT_THRESHOLD - 1; i++) {
        yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      advanceOneStep();
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, currentStep()));

      // Were the counter still at threshold-1, one more failure would lock the
      // account and the next correct code would be refused.
      yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      advanceOneStep();
      const ok = yield* auth.completeStepUpTotp(
        profile.accountId,
        yield* codeAtStep(secret, currentStep()),
      );
      expect(ok.stepUpToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies a CORRECT code when the lockout store itself fails — fail closed", () =>
    Effect.gen(function* () {
      // A guard is not verified until it has been seen to fail, and it is not
      // verified against an account that would have been refused anyway: with
      // no credential enrolled, `checkTotpCode` falls through to the
      // constant-cost "not enrolled" branch and answers the same AuthError
      // whatever `isLocked` returned. So enrol first and submit a code that
      // WOULD be accepted — flip `isLocked` to false and this test goes red.
      //
      // Recovery codes fail OPEN here on purpose; TOTP must not, because a
      // six-digit code has no wide search space behind the counter.
      const { profile, secret } = yield* enrolled("totp-o@example.com", "totpo");

      const broken = {
        backend: "redis" as const,
        isLocked: () => Promise.resolve(true),
        recordFailure: () => Promise.resolve(TOTP_LOCKOUT_THRESHOLD),
        reset: () => Promise.resolve(),
      };
      const failClosedAuth = createAuthService({ ...config, totpLockoutStore: broken });

      const good = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(failClosedAuth.completeStepUpTotp(profile.accountId, good));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it("the in-memory store cannot fail, so failClosed leaves its counting alone", async () => {
    // The fail-closed posture only ever bites on the Redis-backed store (its
    // own tests cover that). Pinned here so nobody "implements" failClosed in
    // the memory backend: reporting a permanent lockout, or a first failure as
    // having reached the threshold, would break every local dev ceremony.
    const store = createInMemoryRecoveryLockoutStore({ failClosed: true, threshold: 3 });
    expect(await store.isLocked("acc_x")).toBe(false);
    expect(await store.recordFailure("acc_x")).toBe(1);
    expect(await store.isLocked("acc_x")).toBe(false);
    expect(await store.recordFailure("acc_x")).toBe(2);
    expect(await store.recordFailure("acc_x")).toBe(3);
    expect(await store.isLocked("acc_x")).toBe(true);
  });
});

describe("TOTP disable", () => {
  it.effect("removes the credential and is idempotent", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-p@example.com", "totpp");

      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      const first = yield* auth.disableTotp(profile.accountId, token);
      expect(first.disabled).toBe(true);

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(false);

      const token2 = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      const second = yield* auth.disableTotp(profile.accountId, token2);
      expect(second.disabled).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a step-up token minted for another ceremony", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-q@example.com", "totpq");
      const wrong = yield* auth.issueStepUpToken(profile.accountId, "passkey", "recovery_generate");
      const err = yield* Effect.flip(auth.disableTotp(profile.accountId, wrong));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP enrolment and disable are audible", () => {
  // The `security_events` row is the only IN-APP channel telling a user their
  // account grew or lost a second factor, and the threat model leans on it. It
  // shares a `commitBatch` with the credential write, so a regression could
  // drop the audit row while the ceremony itself keeps working — nothing else
  // in this file would notice.

  it.effect("enrolment writes totp_enrolled and dispatches the notice", () => {
    const test = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-ev1@example.com", "totpev1");

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events.map((e) => e.kind)).toContain("totp_enrolled");

      // The notice is forked detached — let the fiber finish.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const sent = test.email
        .recorded()
        .filter((e) => e.template === "totp-enrolled" && e.to === "totp-ev1@example.com");
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("disable writes totp_disabled and dispatches the notice", () => {
    const test = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-ev2@example.com", "totpev2");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      yield* auth.disableTotp(profile.accountId, token);

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events.map((e) => e.kind)).toContain("totp_disabled");

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const sent = test.email
        .recorded()
        .filter((e) => e.template === "totp-disabled" && e.to === "totp-ev2@example.com");
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });
});

describe("which gates a totp-AMR step-up token reaches", () => {
  // Four allow-lists, and `recoveryGenerateAllowedAmr` is read by five separate
  // verifiers — so a gate per verifier, not a gate per list. Every one of the
  // five is exercised below by the verifier it actually runs through.
  //
  // Each case pins the DIRECT gate: whether a token carrying `amr: ["totp"]`
  // satisfies that verifier. None of them says anything about what a chain of
  // ceremonies can reach — see wiki/systems/totp.md §Threat model.
  const mintTotpToken = (accountId: string, purpose: Parameters<typeof auth.issueStepUpToken>[2]) =>
    auth.issueStepUpToken(accountId, "totp", purpose);

  it.effect("is ACCEPTED at passkey_register", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-r@example.com", "totpr");
      const token = yield* mintTotpToken(profile.accountId, "passkey_register");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForPasskeyRegister(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is REJECTED at the DIRECT passkey_delete verifier", () =>
    Effect.gen(function* () {
      // What this pins is `passkeyDeleteAllowedAmr` itself: a token carrying
      // `amr: ["totp"]` does not satisfy `verifyStepUpForPasskeyDelete`.
      //
      // This is the DIRECT path only. The register-then-assert pivot reaches
      // the same verifier carrying `amr: ["webauthn"]`, which this list admits,
      // and is closed by the credential-provenance rule rather than by this
      // allow-list — see `tests/services/step-up-provenance.test.ts`, which
      // walks the whole four-request chain.
      const profile = yield* auth.registerProfile("totp-s@example.com", "totps");
      const token = yield* mintTotpToken(profile.accountId, "passkey_delete");
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, token, "pk_000000000000"),
      );
      expect(err.message).toBe("Step-up factor not permitted");
    }).pipe(Effect.provide(makeLayer())),
  );

  // `recoveryGenerateAllowedAmr` gates FIVE ceremonies, not the one its name
  // suggests. Written out per gate rather than table-driven so each names the
  // verifier it actually exercises.
  it.effect("is ACCEPTED at recovery_generate", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-rg@example.com", "totprg");
      const token = yield* mintTotpToken(profile.accountId, "recovery_generate");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at account_delete, which shares that allow-list", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-ad@example.com", "totpad");
      const token = yield* mintTotpToken(profile.accountId, "account_delete");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForAccountDelete(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at account_export, which shares that allow-list", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-ae@example.com", "totpae");
      const token = yield* mintTotpToken(profile.accountId, "account_export");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForAccountExport(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at verifyStepUpForExternalPurpose, the Pulse / Zap app delete", () =>
    Effect.gen(function* () {
      // The cross-service verifier behind ARC-gated `/internal/step-up/verify`.
      // It reads the same allow-list but takes no expected accountId — it
      // returns the token's verified `sub` for the calling service to use.
      const profile = yield* auth.registerProfile("totp-ex@example.com", "totpex");
      const token = yield* mintTotpToken(profile.accountId, "pulse_app_delete");
      const result = yield* auth.verifyStepUpForExternalPurpose(token, "pulse_app_delete");
      expect(result.accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at the security-event ack-all path", () =>
    Effect.gen(function* () {
      // The fifth reader of the list, and the least discoverable from its name.
      // Enrolment left a `totp_enrolled` row, so the ack is a real one — a
      // no-op ack would pass with the gate removed and prove nothing.
      const { profile } = yield* enrolled("totp-ack@example.com", "totpack");
      const token = yield* mintTotpToken(profile.accountId, "security_event_ack");
      const { acknowledged } = yield* auth.acknowledgeAllSecurityEvents(profile.accountId, token);
      expect(acknowledged).toBeGreaterThan(0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is REJECTED at email_change, which keeps an allow-list of its own", () =>
    Effect.gen(function* () {
      // `emailChangeAllowedAmr` in `context.ts` is `["webauthn","otp"]` — the
      // fourth allow-list, and the one no config knob reaches. Left narrow
      // deliberately: the `otp` arm there proves control of the CURRENT
      // mailbox, which a TOTP seed does not.
      //
      // As with `passkey_delete` above, this pins the DIRECT gate only.
      const profile = yield* auth.registerProfile("totp-t@example.com", "totpt");
      const token = yield* mintTotpToken(profile.accountId, "email_change");
      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "123456", token, null),
      );
      expect(err.message).toBe("Step-up factor not permitted");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP without an encryption key", () => {
  it.effect("fails closed rather than storing anything in plain text", () =>
    Effect.gen(function* () {
      const { totpEncryptionKeys: _dropped, ...withoutKey } = config;
      void _dropped;
      const keyless = createAuthService(withoutKey);

      const profile = yield* keyless.registerProfile("totp-u@example.com", "totpu");
      const token = yield* keyless.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");

      const err = yield* Effect.flip(keyless.beginTotpEnrollment(profile.accountId, token));
      expect(err.message).toBe("TOTP is not configured");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("treats an EMPTY key ring the same as no ring at all", () =>
    Effect.gen(function* () {
      // A `Map` is always truthy, so a plain `config.totpEncryptionKeys ? ... :
      // fail` check would accept an empty one and hand it to code that then has
      // no version to write under. Every entry point goes through the same
      // guard, so enrolling and verifying both have to refuse.
      const empty = createAuthService({ ...config, totpEncryptionKeys: new Map() });

      const profile = yield* empty.registerProfile("totp-empty@example.com", "totpempty");
      const token = yield* empty.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");

      const enrolErr = yield* Effect.flip(empty.beginTotpEnrollment(profile.accountId, token));
      expect(enrolErr.message).toBe("TOTP is not configured");

      const verifyErr = yield* Effect.flip(empty.completeStepUpTotp(profile.accountId, "000000"));
      expect(verifyErr.message).toBe("TOTP is not configured");
    }).pipe(Effect.provide(makeLayer())),
  );
});
