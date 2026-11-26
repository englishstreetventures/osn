import { describe, expect, it } from "bun:test";

import { registryRetiredAccounts, registrySettings, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, type TestDb } from "../../src/db/setup";
import { accountErasureService } from "../../src/services/account-erasure";
import { hostsService } from "../../src/services/hosts";
import { registryService } from "../../src/services/registry";
import { weddingLifecycleService } from "../../src/services/wedding-lifecycle";
import { insertWedding } from "../test-helpers/wedding";
import { array, list, seeded } from "./bend";
import {
  type Block,
  type Ev,
  type Maybe,
  type P,
  type Reason,
  type Role,
  model,
} from "./gift-payout-model";

/**
 * One wedding's payout account (laws/gift-payout/payout.bend) against
 * cire-api's services. Each trace starts from a wedding its creator owns, with
 * its registry settings saved once, and runs events through the model and
 * through the services on bun:sqlite: the create route's attach (with the
 * generation) and the OAuth attach (without), the retire, the detach,
 * `account.updated`, the money-gifts save, the hosts writes, the wedding's
 * delete and restore, and an account's erasure. After every event the
 * wedding's liveness and seats, its account, holder, Stripe's charges flag,
 * the switch, the account generation, the retired-account rows, why guests
 * cannot give money and whether the holder is absent must agree, and a gated
 * write must reach the service exactly when the wedding is live.
 *
 * Profile `p` is `usr_<p>` and belongs to account `p % 3`; account `n` is
 * `acct_<n>`. Every account settles in the wedding's currency (AUD). The
 * wedding is on the top tier, so the people limit never refuses an add; a role
 * change is the holder's own, so it never refuses a demotion either; a restore
 * is always inside its seven-day window. Updates carry Stripe times above any
 * clock reading, in order, so the time guard never refuses one.
 */

const WEDDING = "w_pay";
const SLUG = "pay";
const PROFILES = [0, 1, 2, 3, 4, 5];
const ACCOUNTS = [0, 1, 2, 3];
const DEPLOYMENT = { takesPayments: true } as const;
const accountOf = (p: number) => p % 3;
const profilesOf = (a: number) => PROFILES.filter((p) => accountOf(p) === a);
const usr = (p: number) => `usr_${p}`;
const acct = (n: number) => `acct_${n}`;
const roleName = (r: Role): "owner" | "editor" => (r.$ === "Owner" ? "owner" : "editor");
const OWNER: Role = { $: "Owner" };
const EDITOR: Role = { $: "Editor" };
const none: Maybe<number> = { $: "None" };
const some = (value: number): Maybe<number> => ({ $: "Some", value });
const valueOf = (m: Maybe<number>): number | null => (m.$ === "Some" ? m.value : null);

const REASONS: Record<Reason["$"], string> = {
  HandedOver: "handed_over",
  Disconnected: "disconnected",
  Replaced: "replaced",
  HolderAbsent: "holder_absent",
};
const BLOCKS: Record<Block["$"], string | null> = {
  Open: null,
  HolderGone: "payout_holder_absent",
  NotReady: "stripe_not_ready",
  GiftsOff: "cash_gifts_off",
};

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provideService(DbService, db))));

async function created(creator: number): Promise<{ db: TestDb; s: P }> {
  const db = createDb(":memory:");
  insertWedding(db, {
    id: WEDDING,
    slug: SLUG,
    displayName: "Pay",
    tier: "crimson",
    owners: [usr(creator)],
  });
  const saved = await run(
    db,
    registryService.updateSettings(WEDDING, { headline: "Gifts" }, DEPLOYMENT),
  );
  expect(saved._tag).toBe("Success");
  return { db, s: model["payout:created"](creator) };
}

const ownerOf = (s: P): number | undefined =>
  array(s.seats).find((seat) => seat.role.$ === "Owner")?.profile;

/**
 * The organiser routes put the hosts writes and the settings save behind
 * `hostsService.authorize`, which answers null for a deleted wedding; the
 * services themselves do not look. So such a write goes to the service only
 * when the gate lets its caller in.
 */
const gateOpen = async (db: TestDb, actor: string): Promise<boolean> => {
  const seat = await run(db, hostsService.authorize(WEDDING, actor));
  return seat._tag === "Success" && seat.success !== null;
};

/** Applies one event to the code; for a gated write, answers whether the gate let it in. */
async function applyToCode(db: TestDb, s: P, e: Ev, index: number): Promise<boolean | null> {
  const owner = usr(ownerOf(s) ?? 99);
  switch (e.$) {
    case "Connect":
      await run(
        db,
        registryService.attachStripeAccount(
          WEDDING,
          {
            id: acct(e.account),
            chargesEnabled: e.charges,
            payoutsEnabled: false,
            defaultCurrency: "AUD",
          },
          usr(e.by),
          { generation: e.gen },
        ),
      );
      return null;
    case "Join":
      await run(
        db,
        registryService.attachStripeAccount(
          WEDDING,
          {
            id: acct(e.account),
            chargesEnabled: e.charges,
            payoutsEnabled: false,
            defaultCurrency: "AUD",
          },
          usr(e.by),
          { accountType: "standard", ownersMustFit: true },
        ),
      );
      return null;
    case "Retire": {
      const hand = valueOf(e.hand);
      const read = valueOf(e.read);
      await run(
        db,
        registryService.retireStripeAccount(
          {
            weddingId: WEDDING,
            osnProfileId: usr(e.by),
            handTo: hand === null ? null : usr(hand),
            accountId: read === null ? null : acct(read),
            generation: e.gen,
          },
          DEPLOYMENT,
        ),
      );
      return null;
    }
    case "Detach":
      await run(db, registryService.detachStripeAccount({ accountId: acct(e.account) }));
      return null;
    case "Update":
      await run(
        db,
        registryService.applyStripeAccountState({
          id: acct(e.account),
          chargesEnabled: e.charges,
          payoutsEnabled: false,
          defaultCurrency: "AUD",
          observedAt: 4_000_000_000 + index,
        }),
      );
      return null;
    case "Gifts":
      if (!(await gateOpen(db, owner))) return false;
      await run(
        db,
        registryService.updateSettings(WEDDING, { cashGiftsEnabled: e.on }, DEPLOYMENT),
      );
      return true;
    case "Add":
      if (!(await gateOpen(db, owner))) return false;
      await run(
        db,
        hostsService.add({
          weddingId: WEDDING,
          osnProfileId: usr(e.profile),
          addedByOsnProfileId: owner,
          role: roleName(e.role),
        }),
      );
      return true;
    case "Remove":
      if (!(await gateOpen(db, owner))) return false;
      await run(db, hostsService.remove({ weddingId: WEDDING, osnProfileId: usr(e.profile) }));
      return true;
    case "SetRole":
      if (!(await gateOpen(db, usr(e.profile)))) return false;
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING,
          osnProfileId: usr(e.profile),
          role: roleName(e.role),
          actorOsnProfileId: usr(e.profile),
        }),
      );
      return true;
    case "Discard":
      await run(
        db,
        weddingLifecycleService.softDelete({
          weddingId: WEDDING,
          osnProfileId: usr(e.by),
          confirmSlug: SLUG,
        }),
      );
      return null;
    case "Revive":
      await run(
        db,
        weddingLifecycleService.restore({ weddingId: WEDDING, osnProfileId: usr(e.profile) }),
      );
      return null;
    case "Erase": {
      const profiles = array(e.profiles);
      const result = await run(
        db,
        accountErasureService.erase({
          accountId: `acc_${accountOf(profiles[0] ?? 0)}`,
          profileIds: profiles.map(usr),
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", success: { status: "done" } });
      return null;
    }
  }
}

/** What the database holds, in the model's terms. */
async function codeState(db: TestDb) {
  const wedding = db.select().from(weddings).where(eq(weddings.id, WEDDING)).all()[0];
  const row = db
    .select()
    .from(registrySettings)
    .where(eq(registrySettings.weddingId, WEDDING))
    .all()[0];
  const view = await run(db, registryService.settingsView(WEDDING, DEPLOYMENT));
  if (view._tag !== "Success" || !row) throw new Error("the settings row is missing");
  return {
    live: wedding?.deletedAt === null,
    seats: db
      .select({ profile: weddingHosts.osnProfileId, role: weddingHosts.role })
      .from(weddingHosts)
      .where(eq(weddingHosts.weddingId, WEDDING))
      .all()
      .map((seat) => `${seat.profile}:${seat.role}`)
      .toSorted(),
    account: row.stripeAccountId,
    holder: row.stripeConnectedByOsnProfileId,
    charges: row.stripeChargesEnabled,
    gifts: row.cashGiftsEnabled,
    gen: row.stripeAccountGeneration,
    retired: db
      .select()
      .from(registryRetiredAccounts)
      .where(eq(registryRetiredAccounts.weddingId, WEDDING))
      .all()
      .map((r) => `${r.stripeAccountId}:${r.reason}:${r.releasedAt !== null}`)
      .toSorted(),
    block: view.success.moneyGiftsBlockedBy as string | null,
    absent: view.success.payoutHolderAbsent,
  };
}

/** The model's state in the same terms. */
const modelState = (s: P) => {
  const account = valueOf(s.account);
  const holder = valueOf(s.holder);
  return {
    live: s.live,
    seats: array(s.seats)
      .map((seat) => `${usr(seat.profile)}:${roleName(seat.role)}`)
      .toSorted(),
    account: account === null ? null : acct(account),
    holder: holder === null ? null : usr(holder),
    charges: s.charges,
    gifts: s.gifts,
    gen: s.gen,
    retired: array(s.retired)
      .map((r) => `${acct(r.account)}:${REASONS[r.reason.$]}:${r.released}`)
      .toSorted(),
    block: BLOCKS[model["payout:block"](s).$],
    absent: model["payout:absent"](s),
  };
};

const GATED = new Set<Ev["$"]>(["Gifts", "Add", "Remove", "SetRole"]);

/** Runs `next` until it answers null, each event through both, and compares after every one. */
async function expectModelAgrees(
  creator: number,
  next: (s: P, i: number) => Ev | null,
): Promise<void> {
  const start = await created(creator);
  const { db } = start;
  let { s } = start;
  const trace: Ev[] = [];
  for (let i = 0; ; i++) {
    const e = next(s, i);
    if (e === null) return;
    trace.push(e);
    const gate = await applyToCode(db, s, e, i);
    const expectedGate = GATED.has(e.$) ? s.live : null;
    s = model["payout:step"](s, e);
    const at = `event ${i} of ${JSON.stringify(trace)}`;
    expect({ at, gate, ...(await codeState(db)) }).toEqual({
      at,
      gate: expectedGate,
      ...modelState(s),
    });
  }
}

/** A fixed list of events. */
const events =
  (es: ReadonlyArray<Ev>) =>
  (_s: P, i: number): Ev | null =>
    es[i] ?? null;

const connect = (by: number, account: number, gen: number, charges = false): Ev => ({
  $: "Connect",
  by,
  account,
  gen,
  charges,
});
const join = (by: number, account: number, charges = false): Ev => ({
  $: "Join",
  by,
  account,
  charges,
});
const retire = (by: number, hand: number | null, read: number | null, gen: number): Ev => ({
  $: "Retire",
  by,
  hand: hand === null ? none : some(hand),
  read: read === null ? none : some(read),
  gen,
});
const detach = (account: number): Ev => ({ $: "Detach", account });
const update = (account: number, charges: boolean): Ev => ({ $: "Update", account, charges });
const gifts = (on: boolean): Ev => ({ $: "Gifts", on });
const add = (profile: number, role: Role): Ev => ({ $: "Add", profile, role });
const remove = (profile: number): Ev => ({ $: "Remove", profile });
const setRole = (profile: number, role: Role): Ev => ({ $: "SetRole", profile, role });
const discard = (by: number): Ev => ({ $: "Discard", by });
const revive = (profile: number): Ev => ({ $: "Revive", profile });
const erase = (account: number): Ev => ({ $: "Erase", profiles: list(profilesOf(account)) });

describe("one wedding's payout account: the model and cire-api agree", () => {
  it("refuses to remove or demote the holder, and lets them go once they hand money gifts over", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        connect(0, 0, 0, true),
        remove(0),
        setRole(0, EDITOR),
        retire(0, 1, 0, 0),
        setRole(0, EDITOR),
        remove(0),
      ]),
    );
  });

  it("refuses a retire whose generation is stale, even on the same account, or that read no account", async () => {
    await expectModelAgrees(
      0,
      events([
        connect(0, 0, 0),
        detach(0),
        connect(0, 0, 1),
        retire(0, null, 0, 0),
        retire(0, null, null, 1),
        retire(0, null, 0, 1),
      ]),
    );
  });

  it("refuses a connect on a generation another owner moved", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        connect(1, 1, 0),
        retire(1, null, 1, 0),
        connect(0, 1, 0),
        connect(0, 2, 1),
      ]),
    );
  });

  it("an erasure of the holder keeps the account, closes money gifts, and any owner replaces it", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        connect(0, 0, 0, true),
        gifts(true),
        erase(0),
        gifts(true),
        retire(1, null, 0, 0),
        connect(1, 1, 1, true),
      ]),
    );
  });

  it("hands over only from the holder to another owner; another owner's retire is a replace", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        add(2, EDITOR),
        connect(0, 0, 0),
        retire(0, 2, 0, 0),
        retire(0, 0, 0, 0),
        retire(1, 0, 0, 0),
        retire(1, null, 0, 0),
      ]),
    );
  });

  it("turns money gifts on only with a seated holder and charges, and off always", async () => {
    await expectModelAgrees(
      0,
      events([
        gifts(true),
        connect(0, 0, 0, false),
        gifts(true),
        update(0, true),
        gifts(true),
        gifts(false),
        add(1, OWNER),
        erase(0),
        gifts(true),
        gifts(false),
      ]),
    );
  });

  it("a detach clears with no record and moves the generation", async () => {
    await expectModelAgrees(0, events([connect(0, 0, 0), detach(0), connect(0, 1, 1), detach(2)]));
  });

  it("an update for a retired account changes nothing", async () => {
    await expectModelAgrees(
      0,
      events([
        connect(0, 0, 0),
        retire(0, null, 0, 0),
        connect(0, 1, 1),
        update(0, true),
        update(1, true),
      ]),
    );
  });

  it("a detach of a retired account keeps the new one and releases the old records", async () => {
    await expectModelAgrees(
      0,
      events([connect(0, 0, 0), retire(0, null, 0, 0), connect(0, 1, 1), detach(0), detach(1)]),
    );
  });

  it("a deleted wedding refuses connect, retire and the gated writes; restored, they work", async () => {
    await expectModelAgrees(
      0,
      events([
        connect(0, 0, 0),
        discard(0),
        retire(0, null, 0, 0),
        gifts(false),
        detach(0),
        connect(0, 1, 1),
        revive(0),
        connect(0, 1, 1),
        retire(0, null, 1, 1),
      ]),
    );
  });

  it("a connect with no generation fills only an empty account, for an owner of the live wedding", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, EDITOR),
        join(1, 0),
        join(0, 0),
        join(0, 1),
        retire(0, null, 0, 0),
        join(0, 0),
      ]),
    );
  });

  /**
   * Events drawn against the model's state, so most reads are fresh: a
   * connect or a retire carries the wedding's generation four times in five,
   * and a retire the account it names nine times in ten (the route reads the
   * account itself and takes only the generation from the page).
   */
  const drawer = (seed: number) => {
    const rand = seeded(seed);
    const length = 6 + rand.int(10);
    const otherGen = (s: P) => Math.max(0, s.gen + rand.pick([-1, 1]));
    // The holder or an owner half the time, so writes that need one land.
    const someone = (s: P) =>
      rand.chance(0.5)
        ? (valueOf(s.holder) ?? ownerOf(s) ?? rand.pick(PROFILES))
        : rand.pick(PROFILES);
    // A seated profile most of the time, so seat changes have a seat to move.
    const seatedOne = (s: P) => {
      const seats = array(s.seats);
      return seats.length > 0 && rand.chance(0.8) ? rand.pick(seats).profile : rand.pick(PROFILES);
    };
    return {
      creator: rand.pick(PROFILES),
      next: (s: P, i: number): Ev | null => {
        if (i >= length) return null;
        const p = rand.pick(PROFILES);
        const current = valueOf(s.account);
        switch (
          rand.pick([
            "connect",
            "connect",
            "join",
            "retire",
            "retire",
            "retire",
            "detach",
            "update",
            "update",
            "gifts",
            "gifts",
            "add",
            "add",
            "remove",
            "setRole",
            "discard",
            "revive",
            "erase",
          ] as const)
        ) {
          case "connect":
            return connect(
              someone(s),
              rand.pick(ACCOUNTS),
              rand.chance(0.8) ? s.gen : otherGen(s),
              rand.chance(0.5),
            );
          case "join":
            return join(someone(s), rand.pick(ACCOUNTS), rand.chance(0.5));
          case "retire":
            return retire(
              someone(s),
              rand.chance(0.5) ? null : rand.pick(PROFILES),
              rand.chance(0.9) ? current : rand.chance(0.5) ? null : rand.pick(ACCOUNTS),
              rand.chance(0.8) ? s.gen : otherGen(s),
            );
          case "detach":
            return detach(current !== null && rand.chance(0.6) ? current : rand.pick(ACCOUNTS));
          case "update":
            return update(
              current !== null && rand.chance(0.8) ? current : rand.pick(ACCOUNTS),
              rand.chance(0.6),
            );
          case "gifts":
            return gifts(rand.chance(0.7));
          case "add":
            return add(p, rand.chance(0.5) ? OWNER : EDITOR);
          case "remove":
            return remove(seatedOne(s));
          case "setRole":
            return setRole(seatedOne(s), rand.chance(0.5) ? OWNER : EDITOR);
          case "discard":
            return discard(someone(s));
          case "revive":
            return revive(rand.chance(0.7) ? (ownerOf(s) ?? p) : p);
          case "erase":
            return erase(accountOf(p));
        }
      },
    };
  };

  for (let seed = 1; seed <= 60; seed++) {
    it(`agrees on seeded trace ${seed}`, async () => {
      const { creator, next } = drawer(seed);
      await expectModelAgrees(creator, next);
    });
  }
});
