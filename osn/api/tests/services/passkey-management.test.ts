import { it, expect, describe } from "@effect/vitest";
import { passkeys, recoveryCodes, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Passkey management service tests (M-PK):
 *   • list returns a public-safe shape (no publicKey / counter).
 *   • rename enforces label validation + scoping.
 *   • delete emits a security event, revokes other sessions, and refuses
 *     to delete the last passkey unless recovery codes are available.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

/**
 * Seed a raw passkey row via the Db service. We can't run the real WebAuthn
 * ceremony in tests, but the management surface only reads/deletes by
 * `id + accountId`, so a minimal row is enough to cover every branch we
 * care about here.
 */
function seedPasskey(
  accountId: string,
  opts: {
    id?: string;
    label?: string | null;
    credentialId?: string;
    lastUsedAt?: number | null;
  } = {},
) {
  return Effect.gen(function* () {
    const { db } = yield* Db;
    const id = opts.id ?? `pk_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
    const credentialId = opts.credentialId ?? `cred-${id}`;
    yield* Effect.tryPromise(async () => {
      await db.insert(passkeys).values({
        id,
        accountId,
        credentialId,
        publicKey: "AAAA",
        counter: 0,
        transports: null,
        createdAt: new Date(),
        label: opts.label ?? null,
        lastUsedAt: opts.lastUsedAt ?? null,
        aaguid: null,
        backupEligible: false,
        backupState: false,
        updatedAt: null,
      });
    });
    return id;
  });
}

describe("listPasskeys", () => {
  it.effect("returns credentials for this account, newest-used first", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-list-a@example.com", "pklista");
      const bob = yield* auth.registerProfile("pk-list-b@example.com", "pklistb");
      yield* seedPasskey(alice.accountId, { lastUsedAt: 100 });
      yield* seedPasskey(alice.accountId, { lastUsedAt: 200 });
      yield* seedPasskey(bob.accountId, { lastUsedAt: 300 });

      const { passkeys: aliceRows } = yield* auth.listPasskeys(alice.accountId);
      expect(aliceRows).toHaveLength(2);
      expect(aliceRows[0]!.lastUsedAt).toBe(200);
      expect(aliceRows[1]!.lastUsedAt).toBe(100);
      // Public shape: no publicKey / counter.
      for (const row of aliceRows) {
        expect(row).not.toHaveProperty("publicKey");
        expect(row).not.toHaveProperty("counter");
        expect(row.id).toMatch(/^pk_/);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("renamePasskey", () => {
  it.effect("updates the label for a matching passkey", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn@example.com", "pkrn");
      const pkId = yield* seedPasskey(alice.accountId, { label: null });
      yield* auth.renamePasskey(alice.accountId, pkId, "  Work laptop  ");
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows[0]!.label).toBe("Work laptop");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects empty / whitespace-only labels with ValidationError", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn-empty@example.com", "pkrnempty");
      const pkId = yield* seedPasskey(alice.accountId);
      const err = yield* Effect.flip(auth.renamePasskey(alice.accountId, pkId, "   "));
      expect(err._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses to rename a passkey that belongs to another account", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn-cross@example.com", "pkrncross");
      const bob = yield* auth.registerProfile("pk-rn-cross2@example.com", "pkrncross2");
      const pkId = yield* seedPasskey(bob.accountId);
      const err = yield* Effect.flip(auth.renamePasskey(alice.accountId, pkId, "mine"));
      expect(err._tag).toBe("AuthError");
      // Bob's label untouched.
      const { passkeys: bobRows } = yield* auth.listPasskeys(bob.accountId);
      expect(bobRows[0]!.label).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects labels longer than 64 chars with ValidationError", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn-long@example.com", "pkrnlong");
      const pkId = yield* seedPasskey(alice.accountId);
      const err = yield* Effect.flip(auth.renamePasskey(alice.accountId, pkId, "x".repeat(65)));
      expect(err._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("deletePasskey", () => {
  it.effect("removes one passkey, records a security event, and revokes other sessions", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-del@example.com", "pkdel");
      const pk1 = yield* seedPasskey(alice.accountId);
      yield* seedPasskey(alice.accountId); // leave one behind so delete is allowed

      const current = yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      const other = yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      const currentHash = auth.hashSessionToken(current.refreshToken);

      const result = yield* auth.deletePasskey(alice.accountId, pk1, currentHash);
      expect(result.remaining).toBe(1);

      // Passkey row actually gone.
      const { passkeys: remaining } = yield* auth.listPasskeys(alice.accountId);
      expect(remaining).toHaveLength(1);

      // Current session intact; other session revoked (H1).
      yield* auth.verifyRefreshToken(current.refreshToken);
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");

      // Security event recorded.
      const { events } = yield* auth.listUnacknowledgedSecurityEvents(alice.accountId);
      expect(events.some((e) => e.kind === "passkey_delete")).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses to delete the last passkey when there are no recovery codes", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-last@example.com", "pklast");
      const only = yield* seedPasskey(alice.accountId);

      const err = yield* Effect.flip(auth.deletePasskey(alice.accountId, only, null));
      expect(err._tag).toBe("AuthError");
      expect((err as { message: string }).message).toMatch(/recovery codes/i);

      // Row still there.
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("allows deleting the last passkey once recovery codes exist", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-last-ok@example.com", "pklastok");
      const only = yield* seedPasskey(alice.accountId);

      yield* auth.generateRecoveryCodesForAccount(alice.accountId);
      const result = yield* auth.deletePasskey(alice.accountId, only, null);
      expect(result.remaining).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a cross-account id with AuthError", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-xa@example.com", "pkxa");
      const bob = yield* auth.registerProfile("pk-xa2@example.com", "pkxa2");
      const bobPk = yield* seedPasskey(bob.accountId);

      const err = yield* Effect.flip(auth.deletePasskey(alice.accountId, bobPk, null));
      expect(err._tag).toBe("AuthError");

      // Bob's row untouched.
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise(() =>
        db.select().from(passkeys).where(eq(passkeys.id, bobPk)),
      );
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects malformed passkey ids with AuthError", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-bad@example.com", "pkbad");
      const err = yield* Effect.flip(auth.deletePasskey(alice.accountId, "not-a-pk-id", null));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// Ensure the shape never grows silently — explicit projection is the
// boundary between "safe for clients" and "internal state".
describe("listPasskeys hides secret columns", () => {
  it.effect("never returns publicKey or counter", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-hide@example.com", "pkhide");
      yield* seedPasskey(alice.accountId);
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      for (const row of rows) {
        expect(Object.keys(row)).not.toContain("publicKey");
        expect(Object.keys(row)).not.toContain("counter");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// T-U3: positively lock the PasskeySummary key set so a silent drop in the
// explicit projection (e.g. backupEligible going missing) fails loudly.
describe("listPasskeys public shape", () => {
  it.effect("exposes exactly the PasskeySummary field set", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-shape@example.com", "pkshape");
      yield* seedPasskey(alice.accountId, { lastUsedAt: 100 });
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows).toHaveLength(1);
      // S-L2: credentialId is intentionally excluded from the public shape.
      const expectedKeys = [
        "aaguid",
        "backupEligible",
        "backupState",
        "createdAt",
        "id",
        "label",
        "lastUsedAt",
        "transports",
      ];
      expect(Object.keys(rows[0]!).toSorted()).toEqual(expectedKeys);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// T-U2: MAX_PASSKEYS_PER_ACCOUNT cap enforcement — begin refuses past the
// limit; complete's race-guard refuses even if begin was passed concurrently.
describe("passkey count cap (MAX_PASSKEYS_PER_ACCOUNT)", () => {
  it.effect("beginPasskeyRegistration rejects once the account has 10 passkeys", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-cap@example.com", "pkcap");
      for (let i = 0; i < 10; i++) {
        yield* seedPasskey(alice.accountId);
      }
      const err = yield* Effect.flip(auth.beginPasskeyRegistration(alice.accountId));
      expect(err._tag).toBe("AuthError");
      expect((err as { message: string }).message).toMatch(/limit reached/i);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("still allows begin at count = 9", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-cap9@example.com", "pkcap9");
      for (let i = 0; i < 9; i++) {
        yield* seedPasskey(alice.accountId);
      }
      const result = yield* auth.beginPasskeyRegistration(alice.accountId);
      expect(result.options.challenge).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// Guard against silent drift: deleting a passkey must leave recovery codes
// intact (they share the account scope but are independent).
describe("deletePasskey does not touch recovery codes", () => {
  it.effect("preserves existing recovery codes on delete", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rc@example.com", "pkrc");
      yield* seedPasskey(alice.accountId);
      const extra = yield* seedPasskey(alice.accountId);
      yield* auth.generateRecoveryCodesForAccount(alice.accountId);
      const before = yield* auth.countActiveRecoveryCodes(alice.accountId);
      yield* auth.deletePasskey(alice.accountId, extra, null);
      const after = yield* auth.countActiveRecoveryCodes(alice.accountId);
      expect(after.active).toBe(before.active);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// Keep the TS compiler happy about the schema imports we pulled in for
// surface-verification checks.
void recoveryCodes;
void sessions;
