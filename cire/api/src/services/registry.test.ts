import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryContributions,
  registryItems,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import {
  GiftNotInWedding,
  ItemFullyClaimed,
  registryService,
  RegistryItemNotInWedding,
  toEpochSeconds,
} from "./registry";

const OTHER = "wed_other";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings)
    .values({
      id: OTHER,
      slug: "other",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

type Db0 = ReturnType<typeof db0>;

const run = <A, E>(db: Db0, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));

/** Unwrap a success, failing loudly (with the cause) when the Effect failed. */
async function ok<A, E>(db: Db0, eff: Effect.Effect<A, E, DbService>): Promise<A> {
  const exit = await run(db, eff);
  if (Exit.isFailure(exit)) throw new Error(`expected success, got: ${JSON.stringify(exit.cause)}`);
  return exit.value;
}

/** Two seeded households on the bootstrap wedding, for claim contention. */
function twoFamilies(db: Db0): [string, string] {
  const rows = db
    .select({ id: families.id })
    .from(families)
    .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
    .all() as { id: string }[];
  expect(rows.length).toBeGreaterThanOrEqual(2);
  return [rows[0]!.id, rows[1]!.id];
}

const newItem = (over: Partial<{ title: string; quantityWanted: number }> = {}) => ({
  weddingId: BOOTSTRAP_WEDDING_ID,
  title: over.title ?? "Copper pan",
  description: null,
  imageKey: null,
  externalUrl: null,
  priceMinor: 12_000,
  quantityWanted: over.quantityWanted ?? 1,
  category: null,
});

describe("registry settings", () => {
  it("reads as unpublished before any row exists", async () => {
    const db = db0();
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.published).toBe(false);
    expect(snap.settings.cashGiftsEnabled).toBe(false);
    expect(snap.settings.updatedAt).toBeNull();
    expect(snap.items).toEqual([]);
    expect(snap.gifts).toEqual([]);
  });

  it("upserts on first write and patches on the second", async () => {
    const db = db0();
    const first = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: true,
        headline: "Our registry",
      }),
    );
    expect(first.published).toBe(true);
    expect(first.headline).toBe("Our registry");

    // A patch that names only `message` must not reset `published` back to the
    // insert-arm default — the bug an upsert makes easy to write.
    const second = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { message: "No boxed gifts please" }),
    );
    expect(second.published).toBe(true);
    expect(second.headline).toBe("Our registry");
    expect(second.message).toBe("No boxed gifts please");
  });
});

describe("registry items", () => {
  it("appends new items in sort order and reports zero claimed", async () => {
    const db = db0();
    const a = await ok(db, registryService.createItem(newItem({ title: "Pan" })));
    const b = await ok(db, registryService.createItem(newItem({ title: "Kettle" })));
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(a.quantityClaimed).toBe(0);

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.items.map((i) => i.title)).toEqual(["Pan", "Kettle"]);
    // The wedding's primary currency — every authored price is in it.
    expect(snap.currency).toBe("AUD");
  });

  it("refuses to update or delete another wedding's item", async () => {
    const db = db0();
    const item = await ok(db, registryService.createItem(newItem()));
    const update = await run(
      db,
      registryService.updateItem({ weddingId: OTHER, itemId: item.id, patch: { title: "x" } }),
    );
    expect(Exit.isFailure(update)).toBe(true);
    const remove = await run(db, registryService.removeItem(OTHER, item.id));
    expect(Exit.isFailure(remove)).toBe(true);
    // Still there, untouched.
    const rows = db.select().from(registryItems).all() as { title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Copper pan");
  });

  it("reorders only within the wedding", async () => {
    const db = db0();
    const a = await ok(db, registryService.createItem(newItem({ title: "A" })));
    const b = await ok(db, registryService.createItem(newItem({ title: "B" })));
    const c = await ok(db, registryService.createItem(newItem({ title: "C" })));
    await ok(db, registryService.reorderItems(BOOTSTRAP_WEDDING_ID, [c.id, a.id, b.id]));
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.items.map((i) => i.title)).toEqual(["C", "A", "B"]);
  });
});

describe("registryService.claim", () => {
  it("stores timestamps in the same unit a drizzle insert would", async () => {
    // The claim path writes created_at/updated_at through a raw conditional
    // statement, so it can silently disagree with `mode: "timestamp"` (epoch
    // SECONDS). Milliseconds would still write — and date every gift to the year
    // 58000 — so pin the unit against a row drizzle itself wrote.
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    await ok(
      db,
      registryService.claim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
        quantity: 1,
        status: "reserved",
        note: null,
        displayName: null,
      }),
    );
    const [claimRaw] = db.all("SELECT created_at FROM registry_claims") as unknown as Array<{
      created_at: number;
    }>;
    const [itemRaw] = db.all("SELECT created_at FROM registry_items") as unknown as Array<{
      created_at: number;
    }>;
    // Same order of magnitude as the drizzle-written row, and close in time.
    expect(Math.abs(claimRaw!.created_at - itemRaw!.created_at)).toBeLessThan(5);
    expect(claimRaw!.created_at).toBeCloseTo(toEpochSeconds(new Date()), -1);
  });

  it("lets a second household take the remaining quantity", async () => {
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 2 })));
    const base = { weddingId: BOOTSTRAP_WEDDING_ID, itemId: item.id, quantity: 1 } as const;
    await ok(
      db,
      registryService.claim({
        ...base,
        familyId: famA,
        status: "reserved",
        note: null,
        displayName: null,
      }),
    );
    await ok(
      db,
      registryService.claim({
        ...base,
        familyId: famB,
        status: "purchased",
        note: "on its way",
        displayName: "The Bs",
      }),
    );
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.items[0]!.quantityClaimed).toBe(2);
    expect(snap.gifts).toHaveLength(2);
  });

  it("refuses a claim that would oversubscribe the item", async () => {
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 1 })));
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      quantity: 1,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;
    await ok(db, registryService.claim({ ...base, familyId: famA }));

    const exit = await run(db, registryService.claim({ ...base, familyId: famB }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(new ItemFullyClaimed()._tag);
    }
    // The refused claim wrote nothing.
    expect(db.select().from(registryClaims).all()).toHaveLength(1);
  });

  it("survives two households racing for the last one", async () => {
    // The guard lives in the INSERT's WHERE, so the check and the write are one
    // statement and cannot interleave. bun:sqlite is synchronous, so this can't
    // reproduce a true race — but issuing both without awaiting in between is the
    // closest the unit tier gets, and it pins the outcome the guard exists for:
    // exactly one winner, never two rows against a single-quantity item.
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 1 })));
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      quantity: 1,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;

    const [first, second] = await Promise.all([
      run(db, registryService.claim({ ...base, familyId: famA })),
      run(db, registryService.claim({ ...base, familyId: famB })),
    ]);
    const succeeded = [first, second].filter(Exit.isSuccess);
    expect(succeeded).toHaveLength(1);

    const rows = db.select().from(registryClaims).all() as { status: string }[];
    expect(rows.filter((r) => r.status !== "released")).toHaveLength(1);
  });

  it("measures a household's own re-claim against OTHER households only", async () => {
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 3 })));
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;
    await ok(db, registryService.claim({ ...base, familyId: famA, quantity: 1 }));
    await ok(db, registryService.claim({ ...base, familyId: famB, quantity: 1 }));
    // A raises its own 1 → 2. Against others' 1 that is 3 of 3: allowed. If the
    // guard counted A's own existing row it would read 4 and refuse.
    await ok(db, registryService.claim({ ...base, familyId: famA, quantity: 2 }));
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.items[0]!.quantityClaimed).toBe(3);
    // Still one row per household — a re-claim updates, never stacks.
    expect(db.select().from(registryClaims).all()).toHaveLength(2);

    // One more would be 4 of 3.
    const exit = await run(db, registryService.claim({ ...base, familyId: famA, quantity: 3 }));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("frees the quantity on release, and lets a refused household claim after it", async () => {
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 1 })));
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      quantity: 1,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;
    await ok(db, registryService.claim({ ...base, familyId: famA }));
    expect(Exit.isFailure(await run(db, registryService.claim({ ...base, familyId: famB })))).toBe(
      true,
    );

    await ok(
      db,
      registryService.releaseClaim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
      }),
    );
    await ok(db, registryService.claim({ ...base, familyId: famB }));

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.items[0]!.quantityClaimed).toBe(1);
  });

  it("re-claiming after releasing your own row is not mistaken for a refusal", async () => {
    // The released row still satisfies (item, family), so a "did it write?" check
    // that re-read that pair would report success for a claim the guard refused.
    const db = db0();
    const [famA, famB] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 1 })));
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      quantity: 1,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;
    await ok(db, registryService.claim({ ...base, familyId: famA }));
    await ok(
      db,
      registryService.releaseClaim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
      }),
    );
    await ok(db, registryService.claim({ ...base, familyId: famB }));

    // A now wants it back, but B holds the only one. Must FAIL, not silently
    // report success off the stale released row.
    const exit = await run(db, registryService.claim({ ...base, familyId: famA }));
    expect(Exit.isFailure(exit)).toBe(true);
    const rows = db.select().from(registryClaims).all() as { familyId: string; status: string }[];
    expect(rows.find((r) => r.familyId === famA)!.status).toBe("released");
  });

  it("fails 404-class for an item on another wedding", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    const exit = await run(
      db,
      registryService.claim({
        weddingId: OTHER,
        itemId: item.id,
        familyId: famA,
        quantity: 1,
        status: "reserved",
        note: null,
        displayName: null,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(new RegistryItemNotInWedding()._tag);
    }
  });
});

describe("gift log", () => {
  /** A succeeded contribution, written directly (Stripe lands in PR 5). */
  function seedContribution(
    db: Db0,
    over: Partial<{
      amountMinor: number;
      currency: string;
      primaryAmountMinor: number | null;
      primaryCurrency: string | null;
      status: "pending" | "succeeded";
      familyId: string;
      sessionId: string;
    }> = {},
  ) {
    const [famA] = twoFamilies(db);
    const now = new Date();
    const id = `rct_${crypto.randomUUID()}`;
    db.insert(registryContributions)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: null,
        familyId: over.familyId ?? famA,
        status: over.status ?? "succeeded",
        amountMinor: over.amountMinor ?? 10_000,
        currency: over.currency ?? "AUD",
        primaryAmountMinor: over.primaryAmountMinor ?? null,
        primaryCurrency: over.primaryCurrency ?? null,
        fxRate: null,
        fxRateAt: null,
        stripeCheckoutSessionId: over.sessionId ?? `cs_${crypto.randomUUID()}`,
        stripePaymentIntentId: null,
        message: null,
        displayName: null,
        thankedAt: null,
        thankedBy: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  it("merges claims and contributions newest-first", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    await ok(
      db,
      registryService.claim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
        quantity: 1,
        status: "purchased",
        note: "congrats!",
        displayName: null,
      }),
    );
    seedContribution(db);

    const gifts = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    expect(gifts).toHaveLength(2);
    expect(new Set(gifts.map((g) => g.kind))).toEqual(new Set(["claim", "contribution"]));
    const claim = gifts.find((g) => g.kind === "claim")!;
    expect(claim.itemTitle).toBe("Copper pan");
    expect(claim.note).toBe("congrats!");
    // A household name, so the couple knows who to thank.
    expect(claim.familyName.length).toBeGreaterThan(0);
  });

  it("sums contributions in the primary currency, using the snapshot for foreign ones", async () => {
    const db = db0();
    // Same-currency gift: no FX snapshot, contributes its as-given amount.
    seedContribution(db, { amountMinor: 10_000, currency: "AUD" });
    // Foreign gift: the as-given figure is GBP, and only the snapshotted primary
    // equivalent can be added to an AUD total.
    seedContribution(db, {
      amountMinor: 5_000,
      currency: "GBP",
      primaryAmountMinor: 9_700,
      primaryCurrency: "AUD",
    });
    // Pending money is not money yet.
    seedContribution(db, { amountMinor: 99_999, currency: "AUD", status: "pending" });

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.contributionsPrimaryMinor).toBe(10_000 + 9_700);

    const foreign = snap.gifts.find((g) => g.currency === "GBP")!;
    expect(foreign.amountMinor).toBe(5_000);
    expect(foreign.primaryAmountMinor).toBe(9_700);
    expect(foreign.primaryCurrency).toBe("AUD");
  });

  it("keeps a contribution after its item is deleted", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    const now = new Date();
    db.insert(registryContributions)
      .values({
        id: `rct_${crypto.randomUUID()}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
        status: "succeeded",
        amountMinor: 4_000,
        currency: "AUD",
        stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await ok(db, registryService.removeItem(BOOTSTRAP_WEDDING_ID, item.id));

    // Money someone actually sent survives the listing being removed — the FK is
    // ON DELETE SET NULL, not CASCADE.
    const gifts = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    expect(gifts).toHaveLength(1);
    expect(gifts[0]!.itemId).toBeNull();
    expect(gifts[0]!.amountMinor).toBe(4_000);
  });

  it("toggles thank-you status on both gift kinds and rejects a foreign wedding", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    await ok(
      db,
      registryService.claim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: famA,
        quantity: 1,
        status: "reserved",
        note: null,
        displayName: null,
      }),
    );
    const contributionId = seedContribution(db);
    const claimId = (
      db.select({ id: registryClaims.id }).from(registryClaims).all() as {
        id: string;
      }[]
    )[0]!.id;

    for (const [kind, giftId] of [
      ["claim", claimId],
      ["contribution", contributionId],
    ] as const) {
      await ok(
        db,
        registryService.setThanked({
          weddingId: BOOTSTRAP_WEDDING_ID,
          kind,
          giftId,
          thanked: true,
          actorOsnProfileId: "usr_owner",
        }),
      );
    }
    const thanked = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    expect(thanked.every((g) => g.thankedAt !== null)).toBe(true);

    // Un-thank clears the attribution too.
    await ok(
      db,
      registryService.setThanked({
        weddingId: BOOTSTRAP_WEDDING_ID,
        kind: "claim",
        giftId: claimId,
        thanked: false,
        actorOsnProfileId: "usr_owner",
      }),
    );
    const after = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    expect(after.find((g) => g.kind === "claim")!.thankedAt).toBeNull();

    const exit = await run(
      db,
      registryService.setThanked({
        weddingId: OTHER,
        kind: "claim",
        giftId: claimId,
        thanked: true,
        actorOsnProfileId: "usr_bob",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(new GiftNotInWedding()._tag);
    }
  });
});

describe("registryService.hasRows", () => {
  it("is false on a fresh wedding and true once an item exists", async () => {
    const db = db0();
    expect(await ok(db, registryService.hasRows(BOOTSTRAP_WEDDING_ID))).toBe(false);
    await ok(db, registryService.createItem(newItem()));
    expect(await ok(db, registryService.hasRows(BOOTSTRAP_WEDDING_ID))).toBe(true);
    // Scoped: the other wedding is still clean.
    expect(await ok(db, registryService.hasRows(OTHER))).toBe(false);
  });
});
