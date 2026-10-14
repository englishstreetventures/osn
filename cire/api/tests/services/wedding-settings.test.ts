import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, registrySettings, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import {
  CurrencyLockedByCashGifts,
  weddingSettingsService,
} from "../../src/services/wedding-settings";

/**
 * The wedding's currency is what every guest is charged in. Money gifts can
 * only be switched on while the couple's Stripe account settles in that same
 * currency (`registryService.updateSettings`), so a currency change while they
 * are on would leave guests paying into an account that converts each gift on
 * Stripe's terms. The write refuses that change, inside its own statement.
 */

const AUTHOR = "usr_dev_bootstrap_owner";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
}
type Db0 = ReturnType<typeof db0>;

function moneyGifts(
  db: Db0,
  over: { on?: boolean; settles?: string | null; accountId?: string | null } = {},
) {
  const now = new Date();
  db.insert(registrySettings)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      published: true,
      cashGiftsEnabled: over.on ?? true,
      stripeAccountId: over.accountId === undefined ? "acct_couple" : over.accountId,
      stripeChargesEnabled: true,
      stripeDefaultCurrency: over.settles === undefined ? "AUD" : over.settles,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const currencyOf = (db: Db0) =>
  db
    .select({ c: weddings.currency })
    .from(weddings)
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .get()?.c;

const save = (db: Db0, patch: Parameters<typeof weddingSettingsService.update>[1]) =>
  Effect.runPromiseExit(
    weddingSettingsService
      .update(BOOTSTRAP_WEDDING_ID, patch, AUTHOR)
      .pipe(Effect.provideService(DbService, db)),
  );

function expectLocked(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(exit.cause.toString()).toContain(new CurrencyLockedByCashGifts()._tag);
  }
}

describe("changing the wedding's currency while money gifts are on", () => {
  it("is refused when the account settles in the current currency", async () => {
    const db = db0();
    moneyGifts(db, { settles: "AUD" });
    expectLocked(await save(db, { currency: "USD" }));
    expect(currencyOf(db)).toBe("AUD");
  });

  it("is refused when Stripe has not said which currency the account settles in", async () => {
    const db = db0();
    moneyGifts(db, { settles: null });
    expectLocked(await save(db, { currency: "USD" }));
    expect(currencyOf(db)).toBe("AUD");
  });

  it("is allowed when the new currency is the one the account settles in", async () => {
    // A wedding left in the wrong currency can still be put right.
    const db = db0();
    moneyGifts(db, { settles: "USD" });
    const exit = await save(db, { currency: "USD" });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(currencyOf(db)).toBe("USD");
  });

  it("is allowed once money gifts are off", async () => {
    const db = db0();
    moneyGifts(db, { on: false });
    expect(Exit.isSuccess(await save(db, { currency: "USD" }))).toBe(true);
    expect(currencyOf(db)).toBe("USD");
  });

  it("is allowed while no Stripe account is connected", async () => {
    // A revoked account leaves the couple's switch on and its old currency
    // cached; neither may lock the wedding. Reconnecting is checked where the
    // money moves, by the guest gate.
    const db = db0();
    moneyGifts(db, { accountId: null, settles: "AUD" });
    expect(Exit.isSuccess(await save(db, { currency: "USD" }))).toBe(true);
    expect(currencyOf(db)).toBe("USD");
  });

  it("is allowed for a wedding that never opened its registry", async () => {
    const db = db0();
    expect(Exit.isSuccess(await save(db, { currency: "JPY" }))).toBe(true);
    expect(currencyOf(db)).toBe("JPY");
  });

  it("does not judge a save that re-sends the currency it already has", async () => {
    // The owner form sends the whole profile on every save; refusing the value
    // rather than the change would lock the couple out of their own settings.
    const db = db0();
    moneyGifts(db, { settles: "USD" });
    const exit = await save(db, { currency: "AUD", displayName: "Renamed" });
    expect(Exit.isSuccess(exit)).toBe(true);
    const row = db.select().from(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).get();
    expect(row?.displayName).toBe("Renamed");
  });

  it("refuses inside the write, so a switch turned on after the read still holds", async () => {
    // The profile is read, then written. Money gifts switched on between the
    // two must still stop the change: the check rides in the UPDATE itself.
    const db = db0();
    moneyGifts(db, { on: false, settles: "AUD" });
    const client = db.$client;
    const prepare = client.prepare.bind(client);
    Object.defineProperty(client, "prepare", {
      configurable: true,
      value: (sql: string) => {
        if (sql.startsWith('update "weddings"')) {
          prepare("UPDATE registry_settings SET cash_gifts_enabled = 1 WHERE wedding_id = ?").run(
            BOOTSTRAP_WEDDING_ID,
          );
        }
        return prepare(sql);
      },
    });
    const exit = await save(db, { currency: "USD" });
    Reflect.deleteProperty(client, "prepare");
    expectLocked(exit);
    expect(currencyOf(db)).toBe("AUD");
  });
});
