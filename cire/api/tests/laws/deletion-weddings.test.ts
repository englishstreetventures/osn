import { describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, type TestDb } from "../../src/db/setup";
import { accountErasureService } from "../../src/services/account-erasure";
import { hostsService } from "../../src/services/hosts";
import { weddingLifecycleService } from "../../src/services/wedding-lifecycle";
import { insertWedding } from "../test-helpers/wedding";
import { array, seeded } from "./bend";
import { type Role, type W, type WEv, model } from "./model";

/**
 * One wedding's seats (laws/account-deletion/weddings.bend) against cire-api's
 * services. Each trace starts from a wedding its creator owns and runs events
 * through the model and through hostsService (add, remove, a role change
 * made by the seat's own holder), accountErasureService.erase, and the
 * wedding's delete and restore on bun:sqlite; after every event the wedding's
 * liveness, its seats, and each account's deletion preview must agree, and a
 * host change must reach the service exactly when the wedding is live.
 *
 * Profile `p` is `usr_<p>` and belongs to account `p % 3`. One wedding a
 * trace, so an erasure never meets the three-weddings-a-call cap. The wedding
 * is on the top tier, so the people limit never refuses an add. A role
 * change is always the holder's own, so the people limit never refuses a
 * demotion either; a restore is always inside its seven-day window.
 */

const WEDDING = "w_laws";
const WID = 1;
const PROFILES = [0, 1, 2, 3, 4, 5];
const accountOf = (p: number) => p % 3;
const profilesOf = (a: number) => PROFILES.filter((p) => accountOf(p) === a).map((p) => `usr_${p}`);
const ROLES = ["owner", "editor", "viewer", "helper"] as const;
type RoleName = (typeof ROLES)[number];
const roleName = (r: Role): RoleName => r.$.toLowerCase() as RoleName;
const role = (name: RoleName): Role => ({ $: `${name[0]!.toUpperCase()}${name.slice(1)}` }) as Role;

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provideService(DbService, db))));

function created(creator: number): { db: TestDb; w: W } {
  const db = createDb(":memory:");
  insertWedding(db, {
    id: WEDDING,
    slug: "laws",
    displayName: "Laws",
    tier: "crimson",
    owners: [`usr_${creator}`],
  });
  return { db, w: model["weddings:created"](creator, accountOf(creator)) };
}

const ownerOf = (w: W): number | undefined =>
  array(w.seats).find((seat) => seat.role.$ === "Owner")?.profile;

/**
 * The organiser routes put every host change behind `hostsService.authorize`,
 * which answers null for a deleted wedding; `hostsService` itself does not
 * look. So a host change on a deleted wedding is the gate's answer, and a
 * change goes to the service only when the gate lets the caller in.
 */
const gateOpen = async (db: TestDb, actor: string): Promise<boolean> => {
  const seat = await run(db, hostsService.authorize(WEDDING, actor));
  return seat._tag === "Success" && seat.success !== null;
};

/** Applies one event to the code; for a host change, answers whether the route's gate let it in. */
async function applyToCode(db: TestDb, w: W, e: WEv): Promise<boolean | null> {
  const owner = `usr_${ownerOf(w) ?? "none"}`;
  switch (e.$) {
    case "Add": {
      if (!(await gateOpen(db, owner))) return false;
      await run(
        db,
        hostsService.add({
          weddingId: WEDDING,
          osnProfileId: `usr_${e.profile}`,
          addedByOsnProfileId: owner,
          role: roleName(e.role) as never,
        }),
      );
      return true;
    }
    case "Remove":
      if (!(await gateOpen(db, owner))) return false;
      await run(db, hostsService.remove({ weddingId: WEDDING, osnProfileId: `usr_${e.profile}` }));
      return true;
    case "SetRole":
      if (!(await gateOpen(db, `usr_${e.profile}`))) return false;
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING,
          osnProfileId: `usr_${e.profile}`,
          role: roleName(e.role) as never,
          actorOsnProfileId: `usr_${e.profile}`,
        }),
      );
      return true;
    case "EraseAcct": {
      const result = await run(
        db,
        accountErasureService.erase({
          accountId: `acc_${e.account}`,
          profileIds: profilesOf(e.account),
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", success: { status: "done" } });
      return null;
    }
    case "Discard":
      await run(
        db,
        weddingLifecycleService.softDelete({
          weddingId: WEDDING,
          osnProfileId: owner,
          confirmSlug: "laws",
        }),
      );
      return null;
    case "Revive":
      await run(
        db,
        weddingLifecycleService.restore({ weddingId: WEDDING, osnProfileId: `usr_${e.profile}` }),
      );
      return null;
  }
}

const seatsInCode = (db: TestDb) =>
  db
    .select({ profile: weddingHosts.osnProfileId, role: weddingHosts.role })
    .from(weddingHosts)
    .where(eq(weddingHosts.weddingId, WEDDING))
    .all()
    .map((s) => `${s.profile}:${s.role}`)
    .toSorted();

const seatsInModel = (w: W) =>
  array(w.seats)
    .map((s) => `usr_${s.profile}:${roleName(s.role)}`)
    .toSorted();

/** Each account's preview, as the code answers it and as the model does. */
async function previews(db: TestDb, w: W): Promise<{ code: unknown[]; model: unknown[] }> {
  const code: unknown[] = [];
  const fromModel: unknown[] = [];
  for (const account of [0, 1, 2]) {
    const actions = await run(
      db,
      accountErasureService.preview({
        profileIds: profilesOf(account),
        deletesAt: 2_000_000_000,
        organiserOrigin: "https://host.example.test",
      }),
    );
    if (actions._tag !== "Success") throw new Error(`preview failed for account ${account}`);
    code.push(
      actions.success.map((a) => ({
        id: a.id,
        choices: a.choices.map((c) => c.choice),
        fallback: a.defaultChoice,
      })),
    );
    fromModel.push(
      array(model["weddings:preview"](account, WID, w)).map((a) => ({
        id: `cire:wedding:${a.id === WID ? WEDDING : a.id}`,
        choices: array(a.offers).map((c) => (c === 0 ? "delete" : `choice ${c}`)),
        fallback: a.fallback.$ === "Some" ? a.fallback.value : null,
      })),
    );
  }
  return { code, model: fromModel };
}

async function expectModelAgrees(creator: number, trace: ReadonlyArray<WEv>): Promise<void> {
  const start = created(creator);
  const { db } = start;
  let { w } = start;
  for (const [i, e] of trace.entries()) {
    const gate = await applyToCode(db, w, e);
    // A host change reaches the service on a live wedding only.
    const expectedGate = e.$ === "Add" || e.$ === "Remove" || e.$ === "SetRole" ? w.live : null;
    w = model["weddings:step"](w, e);
    const at = `event ${i} of ${JSON.stringify(trace)}`;
    const row = db.select().from(weddings).where(eq(weddings.id, WEDDING)).all()[0];
    const { code, model: expected } = await previews(db, w);
    expect({
      at,
      gate,
      live: row?.deletedAt === null,
      seats: seatsInCode(db),
      previews: code,
    }).toEqual({
      at,
      gate: expectedGate,
      live: w.live,
      seats: seatsInModel(w),
      previews: expected,
    });
  }
}

const add = (profile: number, name: RoleName): WEv => ({
  $: "Add",
  profile,
  account: accountOf(profile),
  role: role(name),
});
const setRole = (profile: number, name: RoleName): WEv => ({
  $: "SetRole",
  profile,
  role: role(name),
});

describe("one wedding: the model and cire-api agree", () => {
  it("deletes a wedding its only owner's account erases, with an editor still seated", async () => {
    await expectModelAgrees(0, [
      add(1, "editor"),
      { $: "EraseAcct", account: 0 },
      { $: "Revive", profile: 1 },
    ]);
  });

  it("keeps a wedding another account's owner holds, and never promotes the editor", async () => {
    await expectModelAgrees(0, [add(1, "owner"), add(2, "editor"), { $: "EraseAcct", account: 0 }]);
  });

  it("refuses to remove or demote the last owner, and allows it once another owner is seated", async () => {
    await expectModelAgrees(0, [
      { $: "Remove", profile: 0 },
      setRole(0, "editor"),
      add(4, "owner"),
      setRole(0, "viewer"),
      { $: "Remove", profile: 4 },
      { $: "Remove", profile: 0 },
    ]);
  });

  it("asks an account about a wedding only while it holds every owner seat", async () => {
    await expectModelAgrees(0, [
      add(3, "owner"),
      add(1, "helper"),
      { $: "Remove", profile: 3 },
      add(2, "owner"),
    ]);
  });

  it("restores a deleted wedding for an owner and not for an editor", async () => {
    await expectModelAgrees(0, [
      add(1, "editor"),
      { $: "Discard" },
      { $: "Revive", profile: 1 },
      { $: "Revive", profile: 0 },
    ]);
  });

  const draw = (seed: number): { creator: number; trace: WEv[] } => {
    const rand = seeded(seed);
    const trace: WEv[] = [];
    const length = 4 + rand.int(8);
    for (let i = 0; i < length; i++) {
      const p = rand.pick(PROFILES);
      const kind = rand.pick([
        "add",
        "add",
        "add",
        "remove",
        "setRole",
        "setRole",
        "erase",
        "discard",
        "revive",
      ] as const);
      switch (kind) {
        case "add":
          trace.push(add(p, rand.pick(ROLES)));
          break;
        case "remove":
          trace.push({ $: "Remove", profile: p });
          break;
        case "setRole":
          trace.push(setRole(p, rand.pick(ROLES)));
          break;
        case "erase":
          trace.push({ $: "EraseAcct", account: accountOf(p) });
          break;
        case "discard":
          trace.push({ $: "Discard" });
          break;
        case "revive":
          trace.push({ $: "Revive", profile: p });
          break;
      }
    }
    return { creator: rand.pick(PROFILES), trace };
  };

  for (let seed = 1; seed <= 60; seed++) {
    it(`agrees on seeded trace ${seed}`, async () => {
      const { creator, trace } = draw(seed);
      await expectModelAgrees(creator, trace);
    });
  }
});
