/**
 * The register-then-assert pivot, and the credential-provenance rule that
 * closes it.
 *
 * The pivot is four requests and needs no recovery at all: step up with a
 * factor `passkeyRegisterAllowedAmr` admits (an emailed OTP, or a TOTP code),
 * register an authenticator of your own, then assert THAT credential — which
 * mints `amr: ["webauthn"]`, exactly what the narrow `passkeyDeleteAllowedAmr`
 * and `emailChangeAllowedAmr` admit — and delete the victim's real passkeys or
 * change the account email. The last-passkey guard needs only one survivor, and
 * the attacker's credential is one.
 *
 * Every test here mints its `webauthn` tokens through `completeStepUpPasskey`
 * rather than `issueStepUpToken`, deliberately. The rule depends on claims the
 * mint path reads off the asserted row; a test that hands those claims in
 * directly proves the verifier and nothing about the half that fills them in.
 *
 * The one that pins the DESIGN rather than the implementation is
 * "inheritance survives another hop" — a plausible implementation that records
 * the raw AMR of the registering step-up passes every other test in this file
 * and leaves the pivot open behind one extra request.
 *
 * See `wiki/systems/step-up.md` and
 * `wiki/architecture/account-recovery-factors.md` §D.
 */

import { it, expect, describe } from "@effect/vitest";
import { accounts, passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeAll, vi } from "vitest";

// Both WebAuthn ceremonies are stubbed: a unit test cannot produce a real
// attestation or assertion. `generateRegistrationOptions` /
// `generateAuthenticationOptions` are left alone, so the challenges are real
// and the store round trips are the ones production makes.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  let credentialSeq = 0;
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => {
      credentialSeq += 1;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: `cred-${credentialSeq}-${Math.random().toString(16).slice(2, 10)}`,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: undefined,
          },
          aaguid: "00000000-0000-0000-0000-000000000000",
          credentialBackedUp: false,
          credentialDeviceType: "singleDevice",
        },
      };
    }),
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })),
  };
});

const { createAuthService } = await import("../../src/services/auth");
const { RECOVERY_COOLDOWN_MS } = await import("../../src/services/auth/constants");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createTestLayer } = await import("../helpers/db");

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

/**
 * Read one credential by id.
 *
 * By ID, and never "the newest row": `passkeys.created_at` is unix SECONDS, so
 * two credentials enrolled back to back tie, and a sort on that column returns
 * an arbitrary one of them. An earlier version of this helper did exactly that
 * and made the inheritance test unable to fail — it read the parent's `otp`
 * provenance and asserted it against the child, so an implementation that
 * stamped the child `webauthn` passed. `completePasskeyRegistration` returns
 * the id it wrote; that is the only reliable handle.
 */
const passkeyById = (passkeyId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.promise(() =>
      db
        .select({
          id: passkeys.id,
          credentialId: passkeys.credentialId,
          createdAt: passkeys.createdAt,
          provenanceAmr: passkeys.provenanceAmr,
        })
        .from(passkeys)
        .where(eq(passkeys.id, passkeyId)),
    );
    return rows[0]!;
  });

/**
 * Move a credential's `created_at` back by `ms`.
 *
 * `passkeys.created_at` is unix SECONDS, so a fixture written in the same
 * second as the credential under test is indistinguishable from it without
 * this — which is the whole reason the rule compares with `<=` and an id guard
 * rather than a bare `<`.
 */
const backdate = (passkeyId: string, ms: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(passkeys)
        .set({ createdAt: new Date(Date.now() - ms) })
        .where(eq(passkeys.id, passkeyId)),
    );
  });

/** Enrol a passkey, optionally through a step-up token. Returns the new row. */
const enrol = (accountId: string, stepUpToken?: string) =>
  Effect.gen(function* () {
    yield* auth.beginPasskeyRegistration(accountId, stepUpToken);
    const { passkeyId } = yield* auth.completePasskeyRegistration(
      accountId,
      fakeAttestation(),
      null,
    );
    return yield* passkeyById(passkeyId);
  });

/** Drive a real passkey step-up ceremony against `credentialId`. */
const assertFor = (
  accountId: string,
  credentialId: string,
  purpose: "passkey_delete" | "email_change" | "passkey_register",
) =>
  Effect.gen(function* () {
    yield* auth.beginStepUpPasskey(accountId);
    const { stepUpToken } = yield* auth.completeStepUpPasskey(
      accountId,
      fakeAssertion(credentialId),
      purpose,
    );
    return stepUpToken;
  });

/**
 * Put a credential's `created_at` on an EXACT unix second.
 *
 * `backdate` subtracts from `Date.now()`, which lands wherever the clock
 * happens to be inside the second. A boundary test has to name the second it
 * is testing, so this takes one.
 */
const stampCreatedAt = (passkeyId: string, sec: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(passkeys)
        .set({ createdAt: new Date(sec * 1000) })
        .where(eq(passkeys.id, passkeyId)),
    );
  });

/** Open the recovery window at an exact unix second. */
const stampRecoveredAt = (accountId: string, sec: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.update(accounts).set({ lastRecoveredAt: sec }).where(eq(accounts.id, accountId)),
    );
  });

/** An account with one bootstrap credential, backdated well clear of the window. */
const seedWithOldPasskey = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    const original = yield* enrol(profile.accountId);
    yield* backdate(original.id, RECOVERY_COOLDOWN_MS * 2);
    return { profile, original };
  });

describe("the register-then-assert pivot is refused at step 4", () => {
  it.effect("otp: a credential registered under an emailed code cannot delete an older one", () =>
    Effect.gen(function* () {
      const { profile, original } = yield* seedWithOldPasskey("prov-otp@example.com", "provotp");

      // Steps 1-2: mint a `passkey_register` step-up on an emailed OTP and bind
      // the attacker's authenticator.
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);
      expect(attacker.provenanceAmr).toBe("otp");

      // Step 3: assert it. This mints `amr: ["webauthn"]`, which the
      // passkey-delete allow-list admits — the token itself is valid.
      const deleteToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );

      // Step 4: refused. Before this rule, the delete went through.
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("totp: the same chain from an authenticator seed", () =>
    Effect.gen(function* () {
      const { profile, original } = yield* seedWithOldPasskey("prov-totp@example.com", "provtotp");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "totp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);
      expect(attacker.provenanceAmr).toBe("totp");

      const deleteToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("the same chain ending at email change is refused", () =>
    Effect.gen(function* () {
      const { profile } = yield* seedWithOldPasskey("prov-ec@example.com", "provec");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "totp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);

      const changeToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "email_change",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForEmailChange(profile.accountId, changeToken),
      );
      expect(err._tag).toBe("AuthError");

      // The chain's real destination: `POST /account/email/begin` mails its OTP
      // to the caller-chosen NEW address, so a token accepted here would end in
      // a permanent, mailbox-independent takeover.
      const swap = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "000000", changeToken, null),
      );
      expect(swap._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("inheritance survives another hop — the pivot cannot be laundered", () =>
    Effect.gen(function* () {
      // THE test for the design rather than the implementation. Recording the
      // raw AMR of the registering step-up passes every other case in this
      // file and leaves the pivot open behind one extra request: register A
      // under `otp`, assert A to register B (a genuine `webauthn` step-up), and
      // B would be stamped `webauthn`.
      const { profile, original } = yield* seedWithOldPasskey(
        "prov-chain@example.com",
        "provchain",
      );

      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const a = yield* enrol(profile.accountId, registerToken);

      const secondRegister = yield* assertFor(profile.accountId, a.credentialId, "passkey_delete");
      // Same allow-list, different purpose: mint a register token by asserting A.
      yield* auth.beginStepUpPasskey(profile.accountId);
      const { stepUpToken: registerViaA } = yield* auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(a.credentialId),
        "passkey_register",
      );
      void secondRegister;

      const b = yield* enrol(profile.accountId, registerViaA);
      expect(b.provenanceAmr).toBe("otp");

      const deleteToken = yield* assertFor(profile.accountId, b.credentialId, "passkey_delete");
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("what the rule must not break", () => {
  it.effect("a passkey registered under a webauthn step-up deletes an older one at once", () =>
    Effect.gen(function* () {
      // Ordinary rotation: the user adds a second device by asserting the one
      // they already hold. If this ever goes red the rule has stopped being a
      // cooldown and become a lock.
      const { profile, original } = yield* seedWithOldPasskey("prov-rot@example.com", "provrot");

      yield* auth.beginStepUpPasskey(profile.accountId);
      const { stepUpToken: registerToken } = yield* auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(original.credentialId),
        "passkey_register",
      );
      const replacement = yield* enrol(profile.accountId, registerToken);
      expect(replacement.provenanceAmr).toBe("webauthn");

      const deleteToken = yield* assertFor(
        profile.accountId,
        replacement.credentialId,
        "passkey_delete",
      );
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(permitted._tag).toBe("Success");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("past 72 hours the chain succeeds — a window, not a permanent lock", () =>
    Effect.gen(function* () {
      const { profile, original } = yield* seedWithOldPasskey("prov-exp@example.com", "provexp");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);
      // Age the weak credential past its own window.
      yield* backdate(attacker.id, RECOVERY_COOLDOWN_MS + 60_000);

      const deleteToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(permitted._tag).toBe("Success");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("effective inheritance: a parent past its window stamps its child webauthn", () =>
    Effect.gen(function* () {
      // Raw inheritance would restrict every device descended from one OTP
      // enrolment for the life of the account — and `config.ts` records that
      // the common reason to add a device by OTP is that the first is hard to
      // reach. A parent free to do the deletion itself cannot be made safer by
      // restricting its children.
      const { profile, original } = yield* seedWithOldPasskey("prov-eff@example.com", "proveff");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const parent = yield* enrol(profile.accountId, registerToken);
      yield* backdate(parent.id, RECOVERY_COOLDOWN_MS + 60_000);

      yield* auth.beginStepUpPasskey(profile.accountId);
      const { stepUpToken: viaParent } = yield* auth.completeStepUpPasskey(
        profile.accountId,
        fakeAssertion(parent.credentialId),
        "passkey_register",
      );
      const child = yield* enrol(profile.accountId, viaParent);
      expect(child.provenanceAmr).toBe("webauthn");

      const deleteToken = yield* assertFor(profile.accountId, child.credentialId, "passkey_delete");
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      expect(permitted._tag).toBe("Success");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a weak credential can always delete itself — the account is never trapped", () =>
    Effect.gen(function* () {
      // The hard requirement: whoever may delete a passkey may always delete
      // the one the weak ceremony enrolled. Same second as its own target, so
      // this also pins the id guard that keeps `<=` from swallowing it.
      const { profile } = yield* seedWithOldPasskey("prov-self@example.com", "provself");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);

      const deleteToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, attacker.id),
      );
      expect(permitted._tag).toBe("Success");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("the bootstrap credential is webauthn, so its lineage is unrestricted", () =>
    Effect.gen(function* () {
      // The account's first passkey follows an email-OTP registration. Stamping
      // it `otp` would, through inheritance, restrict every credential the
      // account ever derived from it — ordinary rotation would never work.
      const profile = yield* auth.registerProfile("prov-boot@example.com", "provboot");
      const first = yield* enrol(profile.accountId);
      expect(first.provenanceAmr).toBe("webauthn");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("fail-closed shapes", () => {
  it.effect("a webauthn token carrying no provenance claims is refused", () =>
    Effect.gen(function* () {
      // Only the signing key can mint one, so this is not an attack path. It is
      // pinned because a rule that reads a missing claim as "unrestricted" is
      // one forgotten mint site away from being no rule at all.
      const { profile, original } = yield* seedWithOldPasskey("prov-bare@example.com", "provbare");
      const bare = yield* auth.issueStepUpToken(profile.accountId, "passkey", "passkey_delete");

      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, bare, original.id),
      );
      expect(err._tag).toBe("AuthError");

      const bareChange = yield* auth.issueStepUpToken(profile.accountId, "passkey", "email_change");
      const changeErr = yield* Effect.flip(
        auth.verifyStepUpForEmailChange(profile.accountId, bareChange),
      );
      expect(changeErr._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a refusal does NOT spend the single-use token", () =>
    Effect.gen(function* () {
      // The provenance decision runs before the jti is consumed. A user refused
      // here has to take a different action, not re-run a ceremony because the
      // refusal burnt their token — and one verification must reach the counter
      // once, not as both `ok` and `provenance_blocked`.
      const { profile, original } = yield* seedWithOldPasskey("prov-jti@example.com", "provjti");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);
      const deleteToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );

      yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, original.id),
      );
      // The same token still works where the rule does not refuse it: deleting
      // the weak credential itself. A consumed jti would fail as a replay.
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, attacker.id),
      );
      expect(permitted._tag).toBe("Success");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a target created in the SAME SECOND as the asserter is refused", () =>
    Effect.gen(function* () {
      // `passkeys.created_at` is unix seconds, so two credentials enrolled back
      // to back carry the same value. A strict `<` lets the second delete the
      // first — the attacker registers twice and the comparison never fires.
      // Nothing else in this file covers it: every other fixture is backdated,
      // which puts the two rows in different seconds and makes `<` and `<=`
      // agree.
      const { profile } = yield* seedWithOldPasskey("prov-tie@example.com", "provtie");

      const firstToken = yield* auth.issueStepUpToken(profile.accountId, "otp", "passkey_register");
      const a = yield* enrol(profile.accountId, firstToken);
      const secondToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const b = yield* enrol(profile.accountId, secondToken);

      // Same second, different rows — the precondition the guard exists for.
      expect(Math.floor(b.createdAt.getTime() / 1000)).toBe(
        Math.floor(a.createdAt.getTime() / 1000),
      );
      expect(b.id).not.toBe(a.id);

      const deleteToken = yield* assertFor(profile.accountId, b.credentialId, "passkey_delete");
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, deleteToken, a.id),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("the RECOVERY window's boundary is strict, and W1 is why that is safe", () =>
    Effect.gen(function* () {
      // The sibling of the test above, for the other window — and the opposite
      // answer, on purpose. The registration-provenance rule compares `<=`
      // because a same-second tie means two credentials' ages cannot be told
      // apart and the older must win. The recovery window asks a different
      // question — "does the target predate the recovery" — and a credential
      // stamped in the recovery's own second does not.
      //
      // Making it `<=` would refuse exactly one asserter that `<` admits: a
      // post-recovery credential carrying `webauthn`, which by the inheritance
      // rule is one the owner derived from a passkey they still hold. That is
      // the credential the whole asymmetry exists to keep working, so this test
      // is what makes the choice deliberate rather than a third seconds-
      // resolution accident.
      const { profile, original } = yield* seedWithOldPasskey("prov-w2@example.com", "provw2");
      const recoveredAt = Math.floor(Date.now() / 1000);
      yield* stampRecoveredAt(profile.accountId, recoveredAt);

      // The owner returns and derives a credential from the passkey they kept.
      // `original` is past its own window, so the child is stamped `webauthn`.
      const registerToken = yield* assertFor(
        profile.accountId,
        original.credentialId,
        "passkey_register",
      );
      const derived = yield* enrol(profile.accountId, registerToken);
      expect(derived.provenanceAmr).toBe("webauthn");

      // A target stamped in the recovery's own second.
      const targetToken = yield* assertFor(
        profile.accountId,
        original.credentialId,
        "passkey_register",
      );
      const target = yield* enrol(profile.accountId, targetToken);
      yield* stampCreatedAt(target.id, recoveredAt);

      const sameSecond = yield* assertFor(
        profile.accountId,
        derived.credentialId,
        "passkey_delete",
      );
      const permitted = yield* Effect.exit(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, sameSecond, target.id),
      );
      expect(permitted._tag).toBe("Success");

      // One second earlier is genuinely pre-recovery, and refused. Without this
      // half the test above would pass on a rule that had been deleted.
      yield* stampCreatedAt(target.id, recoveredAt - 1);
      const secondBefore = yield* assertFor(
        profile.accountId,
        derived.credentialId,
        "passkey_delete",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, secondBefore, target.id),
      );
      expect(err._tag).toBe("AuthError");

      // And the case `<=` was proposed for is already covered by the
      // registration-provenance rule — a WEAK post-recovery credential is
      // refused against the same-second target whatever the recovery window
      // says, which is why the strict comparison above gives nothing away.
      yield* stampCreatedAt(target.id, recoveredAt);
      const weakRegister = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const weak = yield* enrol(profile.accountId, weakRegister);
      expect(weak.provenanceAmr).toBe("otp");
      const weakDelete = yield* assertFor(profile.accountId, weak.credentialId, "passkey_delete");
      const weakErr = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, weakDelete, target.id),
      );
      expect(weakErr._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rename is gated on the same comparison as delete", () =>
    Effect.gen(function* () {
      // Rename shares the `passkey_delete` purpose claim. A credential the rule
      // stops from deleting an older one could otherwise relabel it, which is
      // how a user is talked into confirming a delete on the wrong row.
      const { profile, original } = yield* seedWithOldPasskey("prov-ren@example.com", "provren");
      const registerToken = yield* auth.issueStepUpToken(
        profile.accountId,
        "otp",
        "passkey_register",
      );
      const attacker = yield* enrol(profile.accountId, registerToken);

      const renameToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, renameToken, original.id),
      );
      expect(err._tag).toBe("AuthError");

      // Renaming its OWN row is never blocked.
      const selfToken = yield* assertFor(
        profile.accountId,
        attacker.credentialId,
        "passkey_delete",
      );
      yield* auth.verifyStepUpForPasskeyDelete(profile.accountId, selfToken, attacker.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("the last-passkey guard still holds under the rule", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("prov-last@example.com", "provlast");
      const only = yield* enrol(profile.accountId);
      const err = yield* Effect.flip(auth.deletePasskey(profile.accountId, only.id, null));
      expect(err._tag).toBe("AuthError");
      const { db } = yield* Db;
      const remaining = yield* Effect.promise(() =>
        db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(and(eq(passkeys.accountId, profile.accountId))),
      );
      expect(remaining).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
