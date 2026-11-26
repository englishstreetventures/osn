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

/**
 * A service's answer: `Success`, its failure's tag, or null when the organiser
 * routes' gate kept the call from the service.
 */
type Answer = string | null;

const answerOf = (result: { _tag: "Success" } | { _tag: "Failure"; failure: unknown }): string =>
  result._tag === "Success"
    ? "Success"
    : String((result.failure as { _tag?: unknown } | null)?._tag ?? "untagged");

/**
 * Applies one event to the code. Answers whether the gate let a gated write in
 * (null for an event no gate stands in front of), and the service's answer.
 */
async function applyToCode(
  db: TestDb,
  s: P,
  e: Ev,
  index: number,
): Promise<{ gate: boolean | null; answer: Answer }> {
  const owner = usr(ownerOf(s) ?? 99);
  const ungated = async <A, E>(effect: Effect.Effect<A, E, DbService>) => ({
    gate: null,
    answer: answerOf(await run(db, effect)),
  });
  const gated = async <A, E>(actor: string, effect: () => Effect.Effect<A, E, DbService>) =>
    (await gateOpen(db, actor))
      ? { gate: true, answer: answerOf(await run(db, effect())) }
      : { gate: false, answer: null };
  const account = (n: number, charges: boolean) => ({
    id: acct(n),
    chargesEnabled: charges,
    payoutsEnabled: false,
    defaultCurrency: "AUD",
  });
  switch (e.$) {
    case "Connect":
      return ungated(
        registryService.attachStripeAccount(WEDDING, account(e.account, e.charges), usr(e.by), {
          generation: e.gen,
        }),
      );
    case "Join":
      return ungated(
        registryService.attachStripeAccount(WEDDING, account(e.account, e.charges), usr(e.by), {
          accountType: "standard",
          ownersMustFit: true,
        }),
      );
    case "Retire": {
      const hand = valueOf(e.hand);
      const read = valueOf(e.read);
      return ungated(
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
    }
    // Stripe's webhook passes its own time; cire's OAuth hand-back passes
    // none. Every other detach takes each shape.
    case "Detach":
      return ungated(
        registryService.detachStripeAccount(
          index % 2 === 0
            ? { accountId: acct(e.account), observedAt: 4_000_000_000 + index }
            : { accountId: acct(e.account) },
        ),
      );
    case "Update":
      return ungated(
        registryService.applyStripeAccountState({
          ...account(e.account, e.charges),
          observedAt: 4_000_000_000 + index,
        }),
      );
    case "Gifts":
      return gated(owner, () =>
        registryService.updateSettings(WEDDING, { cashGiftsEnabled: e.on }, DEPLOYMENT),
      );
    case "Add":
      return gated(owner, () =>
        hostsService.add({
          weddingId: WEDDING,
          osnProfileId: usr(e.profile),
          addedByOsnProfileId: owner,
          role: roleName(e.role),
        }),
      );
    case "Remove":
      return gated(owner, () =>
        hostsService.remove({ weddingId: WEDDING, osnProfileId: usr(e.profile) }),
      );
    case "SetRole":
      return gated(usr(e.profile), () =>
        hostsService.setRole({
          weddingId: WEDDING,
          osnProfileId: usr(e.profile),
          role: roleName(e.role),
          actorOsnProfileId: usr(e.profile),
        }),
      );
    case "Discard":
      return ungated(
        weddingLifecycleService.softDelete({
          weddingId: WEDDING,
          osnProfileId: usr(e.by),
          confirmSlug: SLUG,
        }),
      );
    case "Revive":
      return ungated(
        weddingLifecycleService.restore({ weddingId: WEDDING, osnProfileId: usr(e.profile) }),
      );
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
      return { gate: null, answer: answerOf(result) };
    }
  }
}

/**
 * The refusals each service may answer here. Anything else — a write error, a
 * people limit the test's tier and self-only role changes never meet — fails
 * the case: the state could agree while the statement broke.
 */
const REFUSALS: Record<Ev["$"], ReadonlyArray<string>> = {
  Connect: [],
  Join: [],
  Retire: ["StripeRetireForbidden", "StripeAccountChanged", "HandoverNotOwner"],
  Detach: [],
  Update: [],
  Gifts: ["PayoutHolderAbsent", "StripeNotReady"],
  Add: ["HostConflict"],
  Remove: ["LastOwner", "HoldsPayoutAccount"],
  SetRole: ["LastOwner", "HoldsPayoutAccount", "HostNotFound"],
  Discard: ["WeddingLifecycleRefused"],
  Revive: ["WeddingLifecycleRefused"],
  Erase: [],
};

/**
 * What the model says the service answers, where it says: a retire succeeds
 * exactly when it clears the account, and a money-gifts save exactly when it
 * turns them off or the holder is seated with charges on, refusing an absent
 * holder before an account that cannot charge.
 */
function expectedAnswer(before: P, e: Ev, after: P): Answer | undefined {
  switch (e.$) {
    case "Retire":
      return before.account.$ === "Some" && after.account.$ === "None" ? "Success" : undefined;
    case "Gifts":
      if (!before.live) return null;
      if (!e.on) return "Success";
      if (model["payout:absent"](before)) return "PayoutHolderAbsent";
      return before.charges ? "Success" : "StripeNotReady";
    default:
      return undefined;
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
    const { gate, answer } = await applyToCode(db, s, e, i);
    const expectedGate = GATED.has(e.$) ? s.live : null;
    const before = s;
    s = model["payout:step"](s, e);
    const at = `event ${i} of ${JSON.stringify(trace)}`;
    expect({ at, gate, ...(await codeState(db)) }).toEqual({
      at,
      gate: expectedGate,
      ...modelState(s),
    });
    // The answer, as well as the state: a refusal the service may give, and
    // where the model decides it, the very one.
    if (answer !== null && answer !== "Success") {
      const allowed = REFUSALS[e.$].includes(answer);
      expect({ at, answer, allowed }).toEqual({ at, answer, allowed: true });
    }
    const expected = expectedAnswer(before, e, s);
    if (expected !== undefined) expect({ at, answer }).toEqual({ at, answer: expected });
    if (e.$ === "Retire" && expected === undefined)
      expect({ at, answer }).not.toEqual({ at, answer: "Success" });
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

const SEEDS = 60;

const owners = (s: P): number[] =>
  array(s.seats)
    .filter((seat) => seat.role.$ === "Owner")
    .map((seat) => seat.profile);

/**
 * Events drawn against the model's state, so most reads are fresh and most
 * writes have something to act on. Half the traces start with a second owner
 * and an account the creator connected. A connect or a retire carries the
 * wedding's generation four times in five, and a retire reads the account it
 * names nine times in ten (the route reads the account itself and takes only
 * the generation from the page). The caller is the holder or an owner more
 * often than not, and a hand-over names an owner more often than not.
 */
function drawer(seed: number): { creator: number; next: (s: P, i: number) => Ev | null } {
  const rand = seeded(seed);
  const creator = rand.pick(PROFILES);
  const partner = rand.pick(PROFILES.filter((p) => accountOf(p) !== accountOf(creator)));
  const prelude: Ev[] = rand.chance(0.5)
    ? [add(partner, OWNER), connect(creator, rand.pick(ACCOUNTS), 0, rand.chance(0.7))]
    : [];
  const length = prelude.length + 6 + rand.int(10);
  const otherGen = (s: P) => (s.gen === 0 ? 1 : s.gen + rand.pick([-1, 1]));
  const someone = (s: P): number => {
    const holder = valueOf(s.holder);
    const seatedOwners = owners(s);
    if (holder !== null && rand.chance(0.4)) return holder;
    if (seatedOwners.length > 0 && rand.chance(0.5)) return rand.pick(seatedOwners);
    return rand.pick(PROFILES);
  };
  const seatedOne = (s: P): number => {
    const seats = array(s.seats);
    return seats.length > 0 && rand.chance(0.8) ? rand.pick(seats).profile : rand.pick(PROFILES);
  };
  return {
    creator,
    next: (s: P, i: number): Ev | null => {
      if (i < prelude.length) return prelude[i]!;
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
            rand.chance(0.6),
          );
        case "join":
          return join(someone(s), rand.pick(ACCOUNTS), rand.chance(0.6));
        case "retire": {
          const seatedOwners = owners(s);
          const hand = rand.chance(0.4)
            ? null
            : seatedOwners.length > 0 && rand.chance(0.7)
              ? rand.pick(seatedOwners)
              : rand.pick(PROFILES);
          return retire(
            someone(s),
            hand,
            rand.chance(0.9) ? current : rand.chance(0.5) ? null : rand.pick(ACCOUNTS),
            rand.chance(0.8) ? s.gen : otherGen(s),
          );
        }
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
          return remove(rand.chance(0.5) ? someone(s) : seatedOne(s));
        case "setRole":
          return setRole(
            rand.chance(0.5) ? someone(s) : seatedOne(s),
            rand.chance(0.5) ? OWNER : EDITOR,
          );
        case "discard":
          return discard(someone(s));
        case "revive":
          return revive(rand.chance(0.7) ? (ownerOf(s) ?? p) : p);
        case "erase":
          return erase(accountOf(rand.chance(0.5) ? (valueOf(s.holder) ?? p) : p));
      }
    },
  };
}

/**
 * The outcomes the laws turn on, each of which the seeded traces must reach at
 * least once, read off the model alone: a drawer change that stops reaching
 * one fails by name rather than leaving its guard to a single named case.
 */
const OUTCOMES = [
  "a connect fills the account",
  "a connect on a stale generation is refused",
  "a connect with no generation fills the account",
  "a retire hands over",
  "a retire disconnects",
  "a retire replaces a seated holder",
  "a retire replaces an absent holder",
  "a retire on a stale generation is refused",
  "a retire by a caller with no owner seat is refused",
  "a hand-over to someone who is not another owner is refused",
  "a detach clears the account",
  "a detach releases a retired record",
  "an update turns charges on",
  "money gifts turn on",
  "turning money gifts on is refused while the holder is absent",
  "turning money gifts on is refused while Stripe cannot charge",
  "money gifts turn off",
  "the holder rule refuses a removal",
  "the holder rule refuses a move below owner",
  "a seat is removed",
  "an erasure leaves the holder absent",
  "money gifts are open",
  "a wedding is deleted",
  "a wedding is restored",
] as const;

function reached(): Record<(typeof OUTCOMES)[number], boolean> {
  const seen = new Set<string>();
  const isOwner = (s: P, q: number) =>
    array(s.seats).some((seat) => seat.profile === q && seat.role.$ === "Owner");
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { creator, next } = drawer(seed);
    let s = model["payout:created"](creator);
    for (let i = 0; ; i++) {
      const e = next(s, i);
      if (e === null) break;
      const t = model["payout:step"](s, e);
      const cleared = s.account.$ === "Some" && t.account.$ === "None";
      const filled = s.account.$ === "None" && t.account.$ === "Some";
      const holdsSeat = (q: number) =>
        valueOf(s.holder) === q && s.account.$ === "Some" && isOwner(s, q);
      switch (e.$) {
        case "Connect":
          if (filled) seen.add("a connect fills the account");
          if (s.account.$ === "None" && s.live && isOwner(s, e.by) && e.gen !== s.gen)
            seen.add("a connect on a stale generation is refused");
          break;
        case "Join":
          if (filled) seen.add("a connect with no generation fills the account");
          break;
        case "Retire": {
          const newest = array(t.retired)[0];
          if (cleared && newest) {
            seen.add(
              {
                HandedOver: "a retire hands over",
                Disconnected: "a retire disconnects",
                Replaced: "a retire replaces a seated holder",
                HolderAbsent: "a retire replaces an absent holder",
              }[newest.reason.$],
            );
          }
          const fresh = s.account.$ === "Some" && valueOf(e.read) === s.account.value;
          if (fresh && e.gen !== s.gen && s.live && isOwner(s, e.by))
            seen.add("a retire on a stale generation is refused");
          if (fresh && e.gen === s.gen && s.live && !isOwner(s, e.by))
            seen.add("a retire by a caller with no owner seat is refused");
          if (
            fresh &&
            e.gen === s.gen &&
            s.live &&
            isOwner(s, e.by) &&
            e.hand.$ === "Some" &&
            !cleared
          )
            seen.add("a hand-over to someone who is not another owner is refused");
          break;
        }
        case "Detach":
          if (cleared) seen.add("a detach clears the account");
          if (
            array(t.retired).filter((r) => r.released).length >
            array(s.retired).filter((r) => r.released).length
          )
            seen.add("a detach releases a retired record");
          break;
        case "Update":
          if (!s.charges && t.charges) seen.add("an update turns charges on");
          break;
        case "Gifts":
          if (!s.gifts && t.gifts) seen.add("money gifts turn on");
          if (s.gifts && !t.gifts) seen.add("money gifts turn off");
          if (e.on && s.live && model["payout:absent"](s))
            seen.add("turning money gifts on is refused while the holder is absent");
          if (e.on && s.live && !model["payout:absent"](s) && !s.charges)
            seen.add("turning money gifts on is refused while Stripe cannot charge");
          break;
        case "Remove":
          if (s.live && holdsSeat(e.profile) && owners(s).length > 1)
            seen.add("the holder rule refuses a removal");
          if (array(t.seats).length < array(s.seats).length) seen.add("a seat is removed");
          break;
        case "SetRole":
          if (s.live && holdsSeat(e.profile) && e.role.$ === "Editor" && owners(s).length > 1)
            seen.add("the holder rule refuses a move below owner");
          break;
        case "Discard":
          if (s.live && !t.live) seen.add("a wedding is deleted");
          break;
        case "Revive":
          if (!s.live && t.live) seen.add("a wedding is restored");
          break;
        case "Erase":
          if (!model["payout:absent"](s) && model["payout:absent"](t))
            seen.add("an erasure leaves the holder absent");
          break;
      }
      if (model["payout:block"](t).$ === "Open") seen.add("money gifts are open");
      s = t;
    }
  }
  return Object.fromEntries(OUTCOMES.map((name) => [name, seen.has(name)])) as Record<
    (typeof OUTCOMES)[number],
    boolean
  >;
}

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

  it("hands over, the partner connects their own, another owner replaces it, and a detach releases only the first record", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        connect(0, 0, 0, true),
        retire(0, 1, 0, 0),
        connect(1, 1, 1, true),
        retire(0, null, 1, 1),
        detach(0),
      ]),
    );
  });

  it("refuses a retire that read a stale generation, even on the same account, or another account, or none", async () => {
    await expectModelAgrees(
      0,
      events([
        connect(0, 0, 0),
        detach(0),
        connect(0, 0, 1),
        retire(0, null, 0, 0),
        retire(0, null, null, 1),
        retire(0, null, 1, 1),
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
        gifts(false),
        retire(1, null, 0, 0),
        connect(1, 1, 1, true),
        gifts(true),
      ]),
    );
  });

  it("retires only for an owner, hands over only from the holder to another owner, and another owner's retire is a replace", async () => {
    await expectModelAgrees(
      0,
      events([
        add(1, OWNER),
        add(2, EDITOR),
        connect(0, 0, 0),
        retire(2, null, 0, 0),
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

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`agrees on seeded trace ${seed}`, async () => {
      const { creator, next } = drawer(seed);
      await expectModelAgrees(creator, next);
    });
  }

  it("the seeded traces reach every outcome a law turns on", () => {
    const all: Record<string, boolean> = Object.fromEntries(OUTCOMES.map((name) => [name, true]));
    expect(reached() as Record<string, boolean>).toEqual(all);
  });
});
