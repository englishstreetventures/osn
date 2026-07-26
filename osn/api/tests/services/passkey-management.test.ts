import { it, expect, describe } from "@effect/vitest";
import { passkeys, recoveryCodes, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/** Fresh email recorder + merged test layer. Replaces the old sendEmail callback. */
function makeEmailCapture() {
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(createTestLayer(), email.layer),
    latest: (): string | undefined => {
      const all = email.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/(\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
    all: () => email.recorded(),
  };
}

/**
 * Wrap a drizzle query builder so the value it finally resolves to passes
 * through `reshape`. Builders are themselves thenable and chain by returning
 * more builders, so we proxy every method — and intercept `then`, which is the
 * one point where the driver's raw result surfaces.
 */
function wrapChain(node: object, reshape: (real: unknown) => unknown): object {
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          (value as (...a: unknown[]) => unknown).call(
            target,
            (real: unknown) => {
              const shaped = reshape(real);
              return onFulfilled ? onFulfilled(shaped) : shaped;
            },
            onRejected,
          );
      }
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out !== null && typeof out === "object" ? wrapChain(out, reshape) : out;
      };
    },
  });
}

/**
 * A test layer whose UPDATEs report their row count the way Cloudflare D1
 * does — under `meta.changes`, with no top-level `changes` / `rowsAffected`.
 * Everything else runs for real against the in-memory SQLite.
 */
function makeD1ShapedUpdateLayer() {
  const base = createTestLayer();
  const real = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* Db;
      }),
      base,
    ),
  ).db;
  const reshape = (result: unknown) => ({
    success: true,
    meta: { changes: (result as { changes?: number }).changes ?? 0, duration: 0.1 },
    results: [],
  });
  const proxied = new Proxy(real as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "update" && typeof value === "function") {
        return (...args: unknown[]) =>
          wrapChain((value as (...a: unknown[]) => object).apply(target, args), reshape);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof real;
  return Layer.merge(Layer.succeed(Db, { db: proxied }), makeLogEmailLive().layer);
}

/**
 * Passkey management service tests (M-PK):
 *   • list returns a public-safe shape (no publicKey / counter).
 *   • rename enforces label validation + scoping.
 *   • delete emits a security event, revokes other sessions, and refuses
 *     to drop the account below one passkey under any circumstance.
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

  // Regression: the rows-updated gate must read D1's shape. Tests run on
  // bun:sqlite (`{ changes }`), production runs on D1 (`{ meta: { changes } }`),
  // so a reader that only knows the top-level field answered "Passkey not
  // found" for every successful production rename.
  it.effect("succeeds when the driver reports its count D1-style, under `meta.changes`", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn-d1@example.com", "pkrnd1");
      const pkId = yield* seedPasskey(alice.accountId, { label: null });
      yield* auth.renamePasskey(alice.accountId, pkId, "Phone");
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows[0]!.label).toBe("Phone");
    }).pipe(Effect.provide(makeD1ShapedUpdateLayer())),
  );

  it.effect("still reports not-found when a D1-shaped update matches no row", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-rn-d1-miss@example.com", "pkrnd1miss");
      yield* seedPasskey(alice.accountId);
      const err = yield* Effect.flip(
        auth.renamePasskey(alice.accountId, "pk_ffffffffffff", "Nope"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/Passkey not found/);
    }).pipe(Effect.provide(makeD1ShapedUpdateLayer())),
  );
});

describe("deletePasskey", () => {
  it.effect("T-M3: sends passkey-removed notification email on successful delete", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-del-notify@example.com", "pkdelnotify");
      yield* seedPasskey(alice.accountId);
      const toDelete = yield* seedPasskey(alice.accountId);
      yield* auth.deletePasskey(alice.accountId, toDelete, null);

      // The notification is forkDaemon'd — wait for the fiber to complete.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));

      const emails = cap
        .all()
        .filter((e) => e.template === "passkey-removed" && e.to === "pk-del-notify@example.com");
      expect(emails).toHaveLength(1);
    }).pipe(Effect.provide(cap.layer));
  });

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

  it.effect("refuses to delete the last passkey unconditionally", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-last@example.com", "pklast");
      const only = yield* seedPasskey(alice.accountId);

      const err = yield* Effect.flip(auth.deletePasskey(alice.accountId, only, null));
      expect(err._tag).toBe("AuthError");
      expect((err as { message: string }).message).toMatch(/another passkey/i);

      // Row still there.
      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("still refuses the last-passkey delete even when recovery codes exist", () =>
    Effect.gen(function* () {
      // Regression guard: the prior version of this method allowed dropping
      // the last passkey IF active recovery codes existed. That escape hatch
      // was removed — recovery codes are for "lost device", not a substitute
      // credential. This test pins the stricter contract so a future refactor
      // can't quietly reintroduce the old branch.
      const alice = yield* auth.registerProfile("pk-last-rc@example.com", "pklastrc");
      const only = yield* seedPasskey(alice.accountId);

      // Recovery codes are the "device lost" escape hatch, not a substitute
      // credential. The invariant "every account has ≥1 passkey" holds
      // cradle-to-grave.
      yield* auth.generateRecoveryCodesForAccount(alice.accountId);
      const err = yield* Effect.flip(auth.deletePasskey(alice.accountId, only, null));
      expect(err._tag).toBe("AuthError");
      expect((err as { message: string }).message).toMatch(/another passkey/i);

      const { passkeys: rows } = yield* auth.listPasskeys(alice.accountId);
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("allows deleting a passkey when another one remains", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-two@example.com", "pktwo");
      const first = yield* seedPasskey(alice.accountId);
      yield* seedPasskey(alice.accountId);

      const result = yield* auth.deletePasskey(alice.accountId, first, null);
      expect(result.remaining).toBe(1);
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

// S-H1: step-up gate on /passkey/register/* when the account already has
// ≥1 passkey. First-passkey bootstrap is exempt (no ceremony reachable
// before the account has credentials). Prevents silent passkey enrollment
// via a stolen access token.
describe("passkey register step-up gate (S-H1)", () => {
  it.effect("first-passkey enrollment does not require step-up", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-first@example.com", "pkfirst");
      // No passkey seeded — bootstrap path.
      const result = yield* auth.beginPasskeyRegistration(alice.accountId);
      expect(result.options.challenge).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("adding a second passkey without step-up fails with AuthError", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-add@example.com", "pkadd");
      yield* seedPasskey(alice.accountId);
      const err = yield* Effect.flip(auth.beginPasskeyRegistration(alice.accountId));
      expect(err._tag).toBe("AuthError");
      expect((err as { message: string }).message).toMatch(/step.up/i);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("adding a second passkey with a valid step-up token succeeds", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-add-ok@example.com", "pkaddok");
      yield* seedPasskey(alice.accountId);
      yield* auth.beginStepUpOtp(alice.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(alice.accountId, cap.latest()!);
      const result = yield* auth.beginPasskeyRegistration(alice.accountId, stepUpToken);
      expect(result.options.challenge).toBeTruthy();
    }).pipe(Effect.provide(cap.layer));
  });
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

  it.effect("still allows begin at count = 9 (with step-up)", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pk-cap9@example.com", "pkcap9");
      for (let i = 0; i < 9; i++) {
        yield* seedPasskey(alice.accountId);
      }
      // S-H1: begin requires step-up once the account has ≥1 passkey.
      // Mint one via the OTP ceremony.
      yield* auth.beginStepUpOtp(alice.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(alice.accountId, cap.latest()!);
      const result = yield* auth.beginPasskeyRegistration(alice.accountId, stepUpToken);
      expect(result.options.challenge).toBeTruthy();
    }).pipe(Effect.provide(cap.layer));
  });
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
