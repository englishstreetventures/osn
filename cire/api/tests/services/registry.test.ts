import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryContributions,
  registryItems,
  registrySettings,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import {
  CurrencyMismatch,
  FamilyNotInWedding,
  GiftNotInWedding,
  ImageKeyNotInWedding,
  InvalidQuantity,
  ItemFullyClaimed,
  registryService,
  RegistryItemLimitReached,
  RegistryItemNotInWedding,
  SettingsChanged,
  StripeNotReady,
  toEpochSeconds,
} from "../../src/services/registry";

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

/** A succeeded contribution, written directly (Stripe lands in PR 5). */
function seedContribution(
  db: Db0,
  over: Partial<{
    amountMinor: number;
    currency: string;
    primaryAmountMinor: number | null;
    primaryCurrency: string | null;
    refundedAmountMinor: number | null;
    status: "pending" | "succeeded" | "failed" | "refunded" | "disputed";
    familyId: string;
    /** Explicit `null` is meaningful: an attempt that never got a page. */
    sessionId: string | null;
    paymentIntentId: string | null;
    createdAt: Date;
  }> = {},
) {
  const [famA] = twoFamilies(db);
  const now = over.createdAt ?? new Date();
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
      refundedAmountMinor: over.refundedAmountMinor ?? null,
      stripeCheckoutSessionId:
        over.sessionId === undefined ? `cs_${crypto.randomUUID()}` : over.sessionId,
      stripePaymentIntentId: over.paymentIntentId ?? null,
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

describe("the parting gift summary", () => {
  /** Put a summary on the bootstrap wedding's settings row the way the retention
   *  sweep does — blob and timestamp together, in one write. */
  function writeSummary(db: Db0, json: string | null, at: Date | null = new Date()) {
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published: true,
        giftSummaryJson: json,
        giftSummaryAt: at,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const KEPT = {
    sweptOn: "2026-06-17",
    firstGiftOn: "2025-05-11",
    lastGiftOn: "2025-05-20",
    claims: { reserved: 1, purchased: 2 },
    contributions: {
      count: 3,
      totals: [
        { currency: "AUD", amountMinor: 17_500 },
        { currency: "JPY", amountMinor: 3_000 },
      ],
    },
  };

  it("reads as absent for a wedding that was never swept", async () => {
    const db = db0();
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.giftSummary).toBeNull();
  });

  it("carries the counts, the totals and the arrival range back out", async () => {
    const db = db0();
    writeSummary(db, JSON.stringify(KEPT));
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.giftSummary).toEqual(KEPT);
  });

  it("drops keys the summary never had rather than passing them through", async () => {
    // This blob is the one part of the response not built from typed columns.
    // Anything extra in it — a name, a note, a stray debug field — must not
    // reach the portal merely because it was in the row.
    const db = db0();
    writeSummary(db, JSON.stringify({ ...KEPT, displayName: "The Ashworths" }));
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.giftSummary).toEqual(KEPT);
    expect(JSON.stringify(snap.giftSummary)).not.toContain("Ashworth");
  });

  it("reads a damaged or half-written summary as no summary at all", async () => {
    // A throw here would take the whole registry screen down; absent costs one
    // band on a page. Run in parallel — a loop with an await in it is banned.
    const cases: [string, Date | null][] = [
      ["}{ not json", new Date()],
      [JSON.stringify({ sweptOn: "2026-06-17" }), new Date()],
      [JSON.stringify({ ...KEPT, claims: { reserved: "lots" } }), new Date()],
      [
        JSON.stringify({ ...KEPT, contributions: { count: 1, totals: [{ currency: "AUD" }] } }),
        new Date(),
      ],
      // JSON with no `gift_summary_at` is a half-written row, not a record.
      [JSON.stringify(KEPT), null],
    ];
    const snaps = await Promise.all(
      cases.map(([json, at]) => {
        const db = db0();
        writeSummary(db, json, at);
        return ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
      }),
    );
    for (const snap of snaps) expect(snap.giftSummary).toBeNull();
  });
});

describe("registry settings", () => {
  it("reads as unpublished before any row exists", async () => {
    const db = db0();
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.published).toBe(false);
    expect(snap.settings.cashGiftsEnabled).toBe(false);
    expect(snap.settings.updatedAt).toBeNull();
    expect(snap.settings.stripeConnected).toBe(false);
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

describe("registry settings from two organisers at once", () => {
  /** The typed error an Exit failed with, or undefined for a success or a defect. */
  const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
    Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

  /** A saved row, as both organisers loaded it. */
  async function opened(db: Db0) {
    await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: false,
        headline: "Our list",
        shippingAddress: "1 Example St",
      }),
    );
  }

  it("writes a change whose field still holds what the caller saw", async () => {
    const db = db0();
    await opened(db);
    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        headline: "Gifts",
        expected: { headline: "Our list" },
      }),
    );
    expect(saved.headline).toBe("Gifts");
  });

  it("refuses a change to a field someone else has saved since, and writes nothing", async () => {
    const db = db0();
    await opened(db);
    // The other organiser clears the address.
    await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { shippingAddress: null }));

    // This one still sees the old address, edits it, and changes the heading too.
    const exit = await run(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        headline: "Gifts",
        shippingAddress: "2 Example St",
        expected: { headline: "Our list", shippingAddress: "1 Example St" },
      }),
    );
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(SettingsChanged);
    // The refusal carries the row as it now is, so the caller can show it.
    if (error instanceof SettingsChanged) {
      expect(error.current.shippingAddress).toBeNull();
      expect(error.current.headline).toBe("Our list");
    }
    // Neither field moved: the refusal is the whole write, not half of it.
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.shippingAddress).toBeNull();
    expect(snap.settings.headline).toBe("Our list");
  });

  it("matches a field the caller saw as empty against a NULL column", async () => {
    const db = db0();
    await opened(db);
    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        message: "No boxed gifts",
        expected: { message: null },
      }),
    );
    expect(saved.message).toBe("No boxed gifts");
  });

  it("compares a boolean as the 0/1 the column stores", async () => {
    const db = db0();
    await opened(db);
    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: true,
        expected: { published: false },
      }),
    );
    expect(saved.published).toBe(true);
    // A caller that still sees it unpublished, and wants it unpublished, is
    // asking to undo a change it never saw — refused.
    const stale = await run(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: false,
        expected: { published: false },
      }),
    );
    expect(failureOf(stale)).toBeInstanceOf(SettingsChanged);
  });

  it("lets two organisers make the same change, and a retried save go through", async () => {
    const db = db0();
    await opened(db);
    // One organiser publishes.
    await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: true,
        expected: { published: false },
      }),
    );
    // The other, still seeing it unpublished, publishes too — or the first
    // retries after losing the answer. The row already holds what they want.
    const again = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        published: true,
        expected: { published: false },
      }),
    );
    expect(again.published).toBe(true);
  });

  it("checks a field the caller only names in `expected`, without writing it", async () => {
    const db = db0();
    await opened(db);
    await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { published: true }));

    // The caller changes the heading on condition the list is still a draft.
    const refused = await run(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        headline: "Gifts",
        expected: { published: false },
      }),
    );
    expect(failureOf(refused)).toBeInstanceOf(SettingsChanged);
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.headline).toBe("Our list");

    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        headline: "Gifts",
        expected: { published: true },
      }),
    );
    expect(saved.headline).toBe("Gifts");
    expect(saved.published).toBe(true);
  });

  it("answers an empty patch with the row as it stands, without writing it", async () => {
    const db = db0();
    await opened(db);
    const before = db.select().from(registrySettings).all()[0]!.updatedAt;
    const saved = await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {}));
    expect(saved.headline).toBe("Our list");
    expect(saved.shippingAddress).toBe("1 Example St");
    expect(db.select().from(registrySettings).all()[0]!.updatedAt).toEqual(before);

    // And a wedding with no row yet gets the defaults, and still no row.
    const fresh = db0();
    const defaults = await ok(fresh, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {}));
    expect(defaults.published).toBe(false);
    expect(fresh.select().from(registrySettings).all()).toHaveLength(0);
  });

  it("does not check a row that does not exist yet", async () => {
    const db = db0();
    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, {
        headline: "Gifts",
        expected: { headline: null },
      }),
    );
    expect(saved.headline).toBe("Gifts");
  });

  it("sends the organiser a connected flag, never the account id or the payouts flag", async () => {
    const db = db0();
    await opened(db);
    // No account on the row yet: not connected, on the read and on a save.
    expect((await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID))).settings.stripeConnected).toBe(
      false,
    );
    expect(
      (await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { message: "Hi" })))
        .stripeConnected,
    ).toBe(false);

    db.update(registrySettings)
      .set({ stripeAccountId: "acct_live", stripeChargesEnabled: true, stripePayoutsEnabled: true })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.stripeConnected).toBe(true);
    expect(snap.settings.stripeChargesEnabled).toBe(true);
    expect(Object.keys(snap.settings)).not.toContain("stripeAccountId");
    expect(Object.keys(snap.settings)).not.toContain("stripePayoutsEnabled");

    const saved = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { headline: "Gifts" }),
    );
    expect(Object.keys(saved)).not.toContain("stripeAccountId");
    expect(Object.keys(saved)).not.toContain("stripePayoutsEnabled");

    // The server-side readers still get the whole row.
    const record = await ok(db, registryService.settingsOnly(BOOTSTRAP_WEDDING_ID));
    expect(record.stripeAccountId).toBe("acct_live");
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
    // The household DOES belong to the wedding here; the item does not. That is
    // the only order in which the item-shaped failure may be reached — see the
    // test below for why.
    const db = db0();
    const [famA] = twoFamilies(db);
    const exit = await run(
      db,
      registryService.claim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "reg_belongs_to_nobody",
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

  /**
   * THE ORDER IS THE SECURITY PROPERTY. A `cire_session` names a
   * household, not a wedding, so a holder of any valid cookie can aim it at any
   * slug. Checking the ITEM first told them whether the id they guessed exists
   * on a wedding they cannot read; checking the FAMILY first tells them only
   * what they already knew, and the route maps it to the same
   * `registry_not_found` an invisible registry gives.
   */
  it("fails family-shaped, not item-shaped, for a household of another wedding", async () => {
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
      expect(exit.cause.toString()).toContain("FamilyNotInWedding");
      expect(exit.cause.toString()).not.toContain(new RegistryItemNotInWedding()._tag);
    }
  });
});

describe("gift log", () => {
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

    const { entries: gifts } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
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
    // Both rows land in AUD once the snapshot is taken into account, so nothing
    // is left out of the figure.
    expect(snap.contributionsOtherCurrencyCount).toBe(0);

    const foreign = snap.gifts.find((g) => g.currency === "GBP")!;
    expect(foreign.amountMinor).toBe(5_000);
    expect(foreign.primaryAmountMinor).toBe(9_700);
    expect(foreign.primaryCurrency).toBe("AUD");
  });

  it("counts an unconverted foreign gift instead of adding it to the total", async () => {
    const db = db0();
    seedContribution(db, { amountMinor: 10_000, currency: "AUD" });
    // No primary snapshot, so there is no honest way to add this to an AUD
    // total. Adding yen to dollars produces a number that is not money.
    seedContribution(db, { amountMinor: 300_000, currency: "JPY" });
    seedContribution(db, { amountMinor: 4_000, currency: "USD" });

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.contributionsPrimaryMinor).toBe(10_000);
    expect(snap.contributionsOtherCurrencyCount).toBe(2);
  });

  it("does not split one currency in two over the case Stripe writes it in", async () => {
    const db = db0();
    // Authored rows are upper case; the settle path writes whatever Stripe sent,
    // which is lower case. Both are the wedding's own currency.
    seedContribution(db, { amountMinor: 10_000, currency: "AUD" });
    seedContribution(db, { amountMinor: 2_500, currency: "aud" });

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.contributionsPrimaryMinor).toBe(12_500);
    expect(snap.contributionsOtherCurrencyCount).toBe(0);
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
    const { entries: gifts } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
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
    const { entries: thanked } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
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
    const { entries: after } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
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

describe("gift log paging", () => {
  /** `n` succeeded contributions, oldest first, one second apart. */
  function seedRun(db: Db0, n: number, startSecondsAgo = n) {
    for (let i = 0; i < n; i += 1) {
      seedContribution(db, {
        amountMinor: 1_000 + i,
        createdAt: new Date(Date.now() - (startSecondsAgo - i) * 1_000),
      });
    }
  }

  it("caps a page and reports there is more", async () => {
    const db = db0();
    seedRun(db, 55);
    const first = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    // GIFT_LOG_PAGE is 50 — a page, not the table.
    expect(first.entries).toHaveLength(50);
    expect(first.hasMore).toBe(true);

    const second = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID, { offset: 50 }));
    expect(second.entries).toHaveLength(5);
    expect(second.hasMore).toBe(false);

    // The two pages are disjoint and jointly complete.
    const ids = new Set([...first.entries, ...second.entries].map((g) => g.id));
    expect(ids.size).toBe(55);
  });

  it("clamps a nonsense limit or offset instead of trusting it", async () => {
    const db = db0();
    seedRun(db, 3);
    // Negative offset reads as 0; an over-page limit is capped at GIFT_LOG_PAGE.
    const back = await ok(
      db,
      registryService.giftLog(BOOTSTRAP_WEDDING_ID, { offset: -5, limit: 10_000 }),
    );
    expect(back.entries).toHaveLength(3);
    expect(back.hasMore).toBe(false);

    // NaN reads as the floor rather than producing an empty, silent page.
    const nan = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID, { offset: Number.NaN }));
    expect(nan.entries).toHaveLength(3);

    // A limit of 0 would be a page nobody can advance past.
    const zero = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID, { limit: 0 }));
    expect(zero.entries).toHaveLength(1);
    expect(zero.hasMore).toBe(true);
  });

  it("orders the two gift tables against each other, newest first", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    const item = await ok(db, registryService.createItem(newItem()));
    // Older money, then a newer claim: the merge must interleave by time, not
    // concatenate one table after the other.
    seedContribution(db, { createdAt: new Date(Date.now() - 60_000) });
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
    const { entries } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));
    expect(entries.map((g) => g.kind)).toEqual(["claim", "contribution"]);
    expect(entries[0]!.createdAt).toBeGreaterThanOrEqual(entries[1]!.createdAt);
  });

  it("totals ALL succeeded money, not just the money on the first page", async () => {
    const db = db0();
    // 60 gifts of 1_000 — more than one page. A total summed off the page would
    // under-report by 10_000, which is the bug the SQL aggregate exists to stop.
    for (let i = 0; i < 60; i += 1) seedContribution(db, { amountMinor: 1_000 });
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.gifts).toHaveLength(50);
    expect(snap.giftsHasMore).toBe(true);
    expect(snap.contributionsPrimaryMinor).toBe(60_000);
  });

  it("pages the snapshot's gift log through giftsOffset", async () => {
    const db = db0();
    seedRun(db, 52);
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID, { giftsOffset: 50 }));
    expect(snap.gifts).toHaveLength(2);
    expect(snap.giftsHasMore).toBe(false);
    // Items and totals are unaffected by where the gift log is paged to.
    expect(snap.contributionsPrimaryMinor).toBeGreaterThan(0);
  });
});

describe("registry ownership + range guards", () => {
  const foreignKey = `assets/${OTHER}/registry-abc`;
  const ownKey = `assets/${BOOTSTRAP_WEDDING_ID}/registry-abc`;

  it("refuses an image key belonging to another wedding", async () => {
    const db = db0();
    const create = await run(
      db,
      registryService.createItem({ ...newItem(), imageKey: foreignKey }),
    );
    expect(Exit.isFailure(create)).toBe(true);
    if (Exit.isFailure(create)) {
      expect(create.cause.toString()).toContain(new ImageKeyNotInWedding()._tag);
    }

    // The wedding's OWN key is fine, and the same check guards the update path.
    const item = await ok(
      db,
      registryService.createItem({
        ...newItem(),
        imageKey: ownKey,
      }),
    );
    const update = await run(
      db,
      registryService.updateItem({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        patch: { imageKey: foreignKey },
      }),
    );
    expect(Exit.isFailure(update)).toBe(true);
  });

  it("refuses a key naming another SLOT of the same wedding", async () => {
    // The wedding matches, so ownership alone would wave it through. What
    // an item may name is an object minted for the `registry` slot — anything
    // else would let a delete reap an invite or event image.
    const db = db0();
    for (const name of ["hero-0000", "story-0000", "event-0000", "registry_0000"]) {
      const exit = await run(
        db,
        registryService.createItem({
          ...newItem(),
          imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/${name}`,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain(new ImageKeyNotInWedding()._tag);
      }
    }
  });

  it("reports an image key as orphaned only when the deleted item was its last holder", async () => {
    // Two items may carry the same key (duplicate an item, or paste the
    // same picture twice). Reaping on the first delete would blank the survivor.
    const db = db0();
    const first = await ok(db, registryService.createItem({ ...newItem(), imageKey: ownKey }));
    const second = await ok(db, registryService.createItem({ ...newItem(), imageKey: ownKey }));

    const shared = await ok(db, registryService.removeItem(BOOTSTRAP_WEDDING_ID, first.id));
    expect(shared).toEqual({ imageKey: ownKey, imageKeyOrphaned: false });

    const last = await ok(db, registryService.removeItem(BOOTSTRAP_WEDDING_ID, second.id));
    expect(last).toEqual({ imageKey: ownKey, imageKeyOrphaned: true });
  });

  it("refuses an out-of-range quantity on create, update and claim", async () => {
    const db = db0();
    const [famA] = twoFamilies(db);
    for (const quantityWanted of [0, -1, 1.5]) {
      const exit = await run(db, registryService.createItem(newItem({ quantityWanted })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain(new InvalidQuantity()._tag);
      }
    }

    const item = await ok(db, registryService.createItem(newItem({ quantityWanted: 2 })));
    const update = await run(
      db,
      registryService.updateItem({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        patch: { quantityWanted: 0 },
      }),
    );
    expect(Exit.isFailure(update)).toBe(true);

    // A claim is bounded on both sides — the CHECK constraint says 1..99, and a
    // service that let 1e9 through would write a row SQLite then rejects.
    const base = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: item.id,
      familyId: famA,
      status: "reserved",
      note: null,
      displayName: null,
    } as const;
    for (const quantity of [0, 100, 2.5]) {
      const exit = await run(db, registryService.claim({ ...base, quantity }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain(new InvalidQuantity()._tag);
      }
    }
    expect(db.select().from(registryClaims).all()).toHaveLength(0);
  });

  it("refuses a claim for a household on another wedding", async () => {
    const db = db0();
    const item = await ok(db, registryService.createItem(newItem()));
    const now = new Date();
    const foreignFamily = `fam_${crypto.randomUUID()}`;
    db.insert(families)
      .values({
        id: foreignFamily,
        weddingId: OTHER,
        publicId: `OTHER-${crypto.randomUUID().slice(0, 8)}`,
        familyName: "Trespass",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const exit = await run(
      db,
      registryService.claim({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: item.id,
        familyId: foreignFamily,
        quantity: 1,
        status: "reserved",
        note: null,
        displayName: null,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(new FamilyNotInWedding()._tag);
    }
    expect(db.select().from(registryClaims).all()).toHaveLength(0);
  });

  it("refuses to enable cash gifts before Stripe can take a charge", async () => {
    const db = db0();
    const blocked = await run(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { cashGiftsEnabled: true }),
    );
    expect(Exit.isFailure(blocked)).toBe(true);
    if (Exit.isFailure(blocked)) {
      expect(blocked.cause.toString()).toContain(new StripeNotReady()._tag);
    }
    // The refused write created no settings row to half-enable.
    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.settings.cashGiftsEnabled).toBe(false);

    // Once Stripe reports charges enabled, the same patch goes through.
    await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { published: true }));
    db.update(registrySettings)
      .set({ stripeChargesEnabled: true })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();
    const enabled = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { cashGiftsEnabled: true }),
    );
    expect(enabled.cashGiftsEnabled).toBe(true);
  });

  it("refuses cash gifts when Stripe would settle in another currency", async () => {
    const db = db0();
    await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { published: true }));
    // Charges work, but the account settles in dollars while the wedding prices
    // everything in Australian dollars. Checkout would convert or refuse.
    db.update(registrySettings)
      .set({ stripeChargesEnabled: true, stripeDefaultCurrency: "USD" })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    const blocked = await run(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { cashGiftsEnabled: true }),
    );
    expect(Exit.isFailure(blocked)).toBe(true);
    if (Exit.isFailure(blocked)) {
      expect(blocked.cause.toString()).toContain(new CurrencyMismatch()._tag);
    }
    const refused = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(refused.settings.cashGiftsEnabled).toBe(false);

    // The same patch goes through once the two agree.
    db.update(registrySettings)
      .set({ stripeDefaultCurrency: "AUD" })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();
    const enabled = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { cashGiftsEnabled: true }),
    );
    expect(enabled.cashGiftsEnabled).toBe(true);
  });

  it("treats a settlement currency Stripe has not named as unknown, not as a mismatch", async () => {
    const db = db0();
    await ok(db, registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { published: true }));
    db.update(registrySettings)
      .set({ stripeChargesEnabled: true, stripeDefaultCurrency: null })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    const enabled = await ok(
      db,
      registryService.updateSettings(BOOTSTRAP_WEDDING_ID, { cashGiftsEnabled: true }),
    );
    expect(enabled.cashGiftsEnabled).toBe(true);
  });

  it("stops a wedding adding items past the ceiling", async () => {
    const db = db0();
    const now = new Date();
    // Fill to the cap in one statement — 500 service calls would be 500 aggregates.
    db.insert(registryItems)
      .values(
        Array.from({ length: 500 }, (_, i) => ({
          id: `reg_bulk_${i}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          kind: "product" as const,
          title: `Bulk ${i}`,
          quantityWanted: 1,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();

    const exit = await run(db, registryService.createItem(newItem()));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(new RegistryItemLimitReached()._tag);
    }
    // The ceiling is per wedding, not global.
    await ok(db, registryService.createItem({ ...newItem(), weddingId: OTHER }));
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

/** Point the wedding's settings row at a connected account. */
function ownAccount(db: Db0, accountId: string, weddingId = BOOTSTRAP_WEDDING_ID) {
  const now = new Date();
  db.insert(registrySettings)
    .values({ weddingId, stripeAccountId: accountId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: registrySettings.weddingId,
      set: { stripeAccountId: accountId },
    })
    .run();
}

const ACCOUNT = "acct_connected";

/** The one row the contribution tests read back. */
function contribution(db: Db0, id: string) {
  return db.select().from(registryContributions).where(eq(registryContributions.id, id)).get() as {
    status: string;
    refundedAmountMinor: number | null;
    stripeCheckoutSessionId: string | null;
    stripePaymentIntentId: string | null;
  };
}

describe("failContribution", () => {
  it("closes a pending gift whose money is never coming", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "pending", sessionId: "cs_1" });

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: id,
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
      }),
    );

    expect(outcome).toBe("failed");
    expect(contribution(db, id).status).toBe("failed");
  });

  /**
   * THE ONE THAT MATTERS. `checkout.session.expired` is a plausible thing for a
   * hostile connected account to send, and a service that could turn
   * `succeeded` into `failed` on receipt of it would be a way to make a
   * couple's gift vanish.
   */
  it("cannot un-settle a gift somebody actually gave", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "succeeded", sessionId: "cs_1" });

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: id,
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
      }),
    );

    expect(outcome).toBe("ignored");
    expect(contribution(db, id).status).toBe("succeeded");
  });

  it("refuses a failure sent on an account the wedding does not own", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "pending", sessionId: "cs_1" });

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: id,
        checkoutSessionId: "cs_1",
        stripeAccountId: "acct_someone_else",
      }),
    );

    expect(outcome).toBe("rejected");
    expect(contribution(db, id).status).toBe("pending");
  });

  it("refuses a failure naming another session", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "pending", sessionId: "cs_1" });

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: id,
        checkoutSessionId: "cs_other",
        stripeAccountId: ACCOUNT,
      }),
    );

    expect(outcome).toBe("rejected");
    expect(contribution(db, id).status).toBe("pending");
  });

  it("writes nothing for a contribution id that does not exist", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: "rct_forged",
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
      }),
    );

    expect(outcome).toBe("unknown");
    expect(db.select().from(registryContributions).all()).toHaveLength(0);
  });
});

describe("refundContribution", () => {
  it("marks a settled gift refunded, found by its payment intent", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("refunded");
    expect(contribution(db, id).status).toBe("refunded");
  });

  it("refuses a refund from an account the wedding does not own", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: "acct_someone_else",
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("rejected");
    expect(contribution(db, id).status).toBe("succeeded");
  });

  it("is a no-op the second time Stripe delivers the same refund", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "refunded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("ignored");
    expect(contribution(db, id).status).toBe("refunded");
  });

  it("never matches a pending row, which has no intent to refund", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    // A pending row carrying an intent is not a state the settle path writes,
    // but the guard is what keeps a forged refund off a gift still in flight.
    const id = seedContribution(db, { status: "pending", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("unknown");
    expect(contribution(db, id).status).toBe("pending");
  });

  it("refuses to guess when two gifts share one payment intent", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    // Not a shape the settle path writes today — the point is that the column
    // is an index and not a UNIQUE, so nothing at the database stops it, and
    // the refund must not pick one of them by accident of row order.
    const first = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });
    const second = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("ambiguous");
    expect(contribution(db, first).status).toBe("succeeded");
    expect(contribution(db, second).status).toBe("succeeded");
  });

  it("refuses to guess which of two gifts a dispute names", async () => {
    // Same undecidable read the refund path has, and the same answer: nothing
    // is written, and the log is what wants a human.
    const db = db0();
    ownAccount(db, ACCOUNT);
    const first = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });
    const second = seedContribution(db, { status: "succeeded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.disputeContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        resolution: "opened",
      }),
    );

    expect(outcome).toBe("ambiguous");
    expect(contribution(db, first).status).toBe("succeeded");
    expect(contribution(db, second).status).toBe("succeeded");
  });

  it("will not re-open a dispute on a gift already refunded", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "refunded", paymentIntentId: "pi_1" });

    const outcome = await ok(
      db,
      registryService.disputeContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        resolution: "opened",
      }),
    );

    expect(outcome).toBe("ignored");
    expect(contribution(db, id).status).toBe("refunded");
  });

  it("clears the account a couple revoked, and says so only once", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);

    const first = await ok(db, registryService.detachStripeAccount({ accountId: ACCOUNT }));
    // The second delivery — Stripe sends every event at least once — matches
    // nothing, because the id it names is already gone.
    const second = await ok(db, registryService.detachStripeAccount({ accountId: ACCOUNT }));

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("leaves another wedding's account alone", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);

    const matched = await ok(
      db,
      registryService.detachStripeAccount({ accountId: "acct_someone_else" }),
    );

    expect(matched).toBe(false);
    const row = db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeAccountId).toBe(ACCOUNT);
  });

  it("takes a refunded gift out of the primary-currency total", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    seedContribution(db, { amountMinor: 10_000, currency: "AUD" });
    seedContribution(db, {
      amountMinor: 4_000,
      currency: "AUD",
      status: "succeeded",
      paymentIntentId: "pi_1",
    });
    expect(
      (await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID))).contributionsPrimaryMinor,
    ).toBe(14_000);

    await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 4_000,
        fullyRefunded: true,
      }),
    );

    const snap = await ok(db, registryService.get(BOOTSTRAP_WEDDING_ID));
    expect(snap.contributionsPrimaryMinor).toBe(10_000);
  });

  it("records what went back on a partial refund and leaves the gift standing", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
    });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 2_500,
        fullyRefunded: false,
      }),
    );

    expect(outcome).toBe("partial");
    const row = contribution(db, id);
    // The couple kept the rest, so the gift is still a gift — but the row no
    // longer claims the whole amount survived.
    expect(row.status).toBe("succeeded");
    expect(row.refundedAmountMinor).toBe(2_500);
  });

  it("records the amount on a full refund as well as moving the status", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
    });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 10_000,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("refunded");
    const row = contribution(db, id);
    expect(row.status).toBe("refunded");
    expect(row.refundedAmountMinor).toBe(10_000);
  });

  it("keeps the recorded amount when a stale delivery reports less", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
      refundedAmountMinor: 4_000,
    });

    // Stripe's `amount_refunded` is the running total across every refund on the
    // charge, and deliveries can arrive out of order, so a smaller figure is an
    // older event and not news.
    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: 1_000,
        fullyRefunded: false,
      }),
    );

    expect(outcome).toBe("partial");
    expect(contribution(db, id).refundedAmountMinor).toBe(4_000);
  });

  it("writes nothing when a partial refund carries no usable amount", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
    });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: null,
        fullyRefunded: false,
      }),
    );

    expect(outcome).toBe("partial");
    const row = contribution(db, id);
    expect(row.status).toBe("succeeded");
    // NULL reads as "not recorded", which is the truth — falling back to the
    // row's own amount would invent a figure Stripe never sent.
    expect(row.refundedAmountMinor).toBeNull();
  });

  it("refuses a partial refund from an account the wedding does not own", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
    });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: "acct_someone_else",
        refundedAmountMinor: 2_500,
        fullyRefunded: false,
      }),
    );

    expect(outcome).toBe("rejected");
    const row = contribution(db, id);
    expect(row.status).toBe("succeeded");
    expect(row.refundedAmountMinor).toBeNull();
  });

  it("moves a full refund that carried no amount, and records nothing", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, {
      amountMinor: 10_000,
      status: "succeeded",
      paymentIntentId: "pi_1",
    });

    const outcome = await ok(
      db,
      registryService.refundContribution({
        paymentIntentId: "pi_1",
        stripeAccountId: ACCOUNT,
        refundedAmountMinor: null,
        fullyRefunded: true,
      }),
    );

    expect(outcome).toBe("refunded");
    const row = contribution(db, id);
    expect(row.status).toBe("refunded");
    expect(row.refundedAmountMinor).toBeNull();
  });
});

describe("what the couple sees of a gift that failed", () => {
  it("hides a failed contribution and keeps a refunded one", async () => {
    const db = db0();
    seedContribution(db, { amountMinor: 10_000, status: "succeeded" });
    seedContribution(db, { amountMinor: 7_000, status: "refunded", paymentIntentId: "pi_1" });
    // Money that never moved is not a gift, and a guest who abandoned checkout
    // never meant to tell the couple anything.
    seedContribution(db, { amountMinor: 99_999, status: "failed" });

    const { entries } = await ok(db, registryService.giftLog(BOOTSTRAP_WEDDING_ID));

    expect(entries.map((g) => g.amountMinor).toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      7_000, 10_000,
    ]);
    // A refund is a thing that HAPPENED to the couple's record, so it stays
    // visible — out of the total, still in the log.
    expect(entries.some((g) => g.status === "refunded")).toBe(true);
  });
});

/**
 * The gift row now exists BEFORE Stripe is asked for a payment page, so its
 * session id starts NULL and is attached afterwards. What
 * follows is every way that window can end: the page arrives and is attached,
 * the same page arrives twice, two rows race for one page, and the row is gone.
 */
describe("createPendingContribution", () => {
  const pending = (db: Db0, id: string) => ({
    id,
    weddingId: BOOTSTRAP_WEDDING_ID,
    familyId: twoFamilies(db)[0],
    itemId: null,
    amountMinor: 5000,
    currency: "AUD",
    message: null,
    displayName: null,
  });

  it("writes the gift with no session id at all", async () => {
    const db = db0();
    const id = `rct_${crypto.randomUUID()}`;

    expect(await ok(db, registryService.createPendingContribution(pending(db, id)))).toBe(true);

    const row = contribution(db, id);
    expect(row.status).toBe("pending");
    expect(row.stripeCheckoutSessionId).toBeNull();
  });

  /**
   * The id is minted fresh per request, so a second insert under the same id is
   * a UUID collision, not a retry. The honest answer is `false` — and no
   * payment page — rather than silently handing the guest somebody else's gift.
   */
  it("refuses to write over a gift that already has that id", async () => {
    const db = db0();
    const id = `rct_${crypto.randomUUID()}`;
    await ok(db, registryService.createPendingContribution(pending(db, id)));

    const second = await ok(
      db,
      registryService.createPendingContribution({ ...pending(db, id), amountMinor: 99_000 }),
    );

    expect(second).toBe(false);
    // The first gift is untouched — the collision wrote nothing.
    expect(
      db
        .select({ amountMinor: registryContributions.amountMinor })
        .from(registryContributions)
        .where(eq(registryContributions.id, id))
        .get()?.amountMinor,
    ).toBe(5000);
  });
});

describe("attachCheckoutSession", () => {
  it("attaches the page Stripe handed back", async () => {
    const db = db0();
    const id = seedContribution(db, { status: "pending", sessionId: null });

    const outcome = await ok(
      db,
      registryService.attachCheckoutSession({ contributionId: id, checkoutSessionId: "cs_1" }),
    );

    expect(outcome).toBe("attached");
    expect(contribution(db, id).stripeCheckoutSessionId).toBe("cs_1");
  });

  /** A retry of the same attach is the same answer, not a second write. */
  it("is idempotent when the row already holds that session", async () => {
    const db = db0();
    const id = seedContribution(db, { status: "pending", sessionId: "cs_1" });

    const outcome = await ok(
      db,
      registryService.attachCheckoutSession({ contributionId: id, checkoutSessionId: "cs_1" }),
    );

    expect(outcome).toBe("attached");
    expect(contribution(db, id).stripeCheckoutSessionId).toBe("cs_1");
  });

  /**
   * One session id belongs to exactly one gift. A row that loses the race has
   * no page of its own and never will, so it is closed rather than left
   * `pending` for an organiser to wait on.
   */
  it("closes the loser when a session already belongs to another gift", async () => {
    const db = db0();
    const winner = seedContribution(db, { status: "pending", sessionId: "cs_1" });
    const loser = seedContribution(db, { status: "pending", sessionId: null });

    const outcome = await ok(
      db,
      registryService.attachCheckoutSession({ contributionId: loser, checkoutSessionId: "cs_1" }),
    );

    expect(outcome).toBe("duplicate");
    expect(contribution(db, loser).status).toBe("failed");
    expect(contribution(db, loser).stripeCheckoutSessionId).toBeNull();
    // The gift that got there first keeps the page.
    expect(contribution(db, winner).status).toBe("pending");
    expect(contribution(db, winner).stripeCheckoutSessionId).toBe("cs_1");
  });

  it("says so when there is no such gift", async () => {
    const db = db0();
    const outcome = await ok(
      db,
      registryService.attachCheckoutSession({
        contributionId: "rct_gone",
        checkoutSessionId: "cs_1",
      }),
    );
    expect(outcome).toBe("missing");
  });
});

describe("abandonPendingContribution", () => {
  it("closes an attempt Stripe never gave a page to", async () => {
    const db = db0();
    const id = seedContribution(db, { status: "pending", sessionId: null });

    await ok(db, registryService.abandonPendingContribution({ contributionId: id }));

    expect(contribution(db, id).status).toBe("failed");
  });

  /**
   * The guard is three clauses, and this is the one that matters: a row that
   * DID get a session is a live payment page, and a late failure on the request
   * that opened it must not close a gift the guest may already be paying.
   */
  it("leaves a gift that already has a payment page alone", async () => {
    const db = db0();
    const id = seedContribution(db, { status: "pending", sessionId: "cs_1" });

    await ok(db, registryService.abandonPendingContribution({ contributionId: id }));

    expect(contribution(db, id).status).toBe("pending");
  });
});

describe("findReusableContribution", () => {
  const reuse = (db: Db0) => ({
    weddingId: BOOTSTRAP_WEDDING_ID,
    familyId: twoFamilies(db)[0],
    itemId: null,
    amountMinor: 10_000,
    message: null,
    displayName: null,
    since: new Date(Date.now() - 60_000),
  });

  it("hands back the page an identical attempt already got", async () => {
    const db = db0();
    seedContribution(db, { status: "pending", sessionId: "cs_1" });

    expect(await ok(db, registryService.findReusableContribution(reuse(db)))).toEqual({
      sessionId: "cs_1",
    });
  });

  /**
   * A NULL session is an attempt that never reached Stripe —
   * there is no page to send anyone back to, so reuse must skip it. Returning
   * it would hand the guest a `null` URL.
   */
  it("skips an attempt that never got a page", async () => {
    const db = db0();
    seedContribution(db, { status: "pending", sessionId: null });

    expect(await ok(db, registryService.findReusableContribution(reuse(db)))).toBeNull();
  });
});

describe("settling a gift whose session was never attached", () => {
  it("adopts the session id the webhook names", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "pending", sessionId: null });

    const outcome = await ok(
      db,
      registryService.settleContribution({
        contributionId: id,
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
        paymentIntentId: "pi_1",
        paid: true,
        paidAmountMinor: 10_000,
        paidCurrency: "AUD",
      }),
    );

    expect(outcome).toBe("settled");
    const row = contribution(db, id);
    expect(row.status).toBe("succeeded");
    // The window closes here: the gift is paid AND now names its own session.
    expect(row.stripeCheckoutSessionId).toBe("cs_1");
    expect(row.stripePaymentIntentId).toBe("pi_1");
  });

  /** Adoption is guarded: a session another gift already holds is not free. */
  it("refuses to adopt a session another gift already holds", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const holder = seedContribution(db, { status: "succeeded", sessionId: "cs_1" });
    const orphan = seedContribution(db, { status: "pending", sessionId: null });

    const outcome = await ok(
      db,
      registryService.settleContribution({
        contributionId: orphan,
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
        paymentIntentId: "pi_1",
        paid: true,
        paidAmountMinor: 10_000,
        paidCurrency: "AUD",
      }),
    );

    expect(outcome).toBe("rejected");
    expect(contribution(db, orphan).status).toBe("pending");
    expect(contribution(db, orphan).stripeCheckoutSessionId).toBeNull();
    expect(contribution(db, holder).status).toBe("succeeded");
  });

  /**
   * The other end of the same window: the guest walked away, the session
   * expired, and the expiry event is the first thing that ever names the
   * session. The row is closed and stamped with the session it was.
   */
  it("closes an orphan on expiry, and records which session expired", async () => {
    const db = db0();
    ownAccount(db, ACCOUNT);
    const id = seedContribution(db, { status: "pending", sessionId: null });

    const outcome = await ok(
      db,
      registryService.failContribution({
        contributionId: id,
        checkoutSessionId: "cs_1",
        stripeAccountId: ACCOUNT,
      }),
    );

    expect(outcome).toBe("failed");
    const row = contribution(db, id);
    expect(row.status).toBe("failed");
    expect(row.stripeCheckoutSessionId).toBe("cs_1");
  });
});
