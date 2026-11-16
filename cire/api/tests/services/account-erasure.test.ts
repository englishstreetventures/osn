import { describe, expect, it } from "bun:test";

import {
  directoryVendors,
  guestAccountLinks,
  hostRsvpNotices,
  organiserSessions,
  ownerNoticeBudget,
  realtimeSubscribeBudget,
  weddingHosts,
  weddings,
} from "@cire/db";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  accountErasureService,
  MAX_OWNED_WEDDINGS_PER_CALL,
} from "../../src/services/account-erasure";
import { beforeStatement, failStatements, recordStatements } from "../test-helpers";
import { fullWeddingStatements } from "../test-helpers/full-wedding";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

/**
 * An OSN account's erasure in cire, and the preview of what it would leave
 * open. Each test names the failure it guards in `NEW-FEAT.md` (F8…F44).
 */

const NOW = new Date("2026-11-16T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 24 * 60 * 60;
const PORTAL = "https://host.example.test";
const ACCOUNT = "acc_erased";
const P = "usr_erased";
const P2 = "usr_erased_second";
const OTHER = "usr_other";
const EDITOR = "usr_editor";
/** What a column that cannot be NULL holds once the profile it named is erased. */
const DELETED = "deleted";

function makeDb(): TestDb {
  return createDb(":memory:");
}

function seat(
  db: TestDb,
  weddingId: string,
  osnProfileId: string,
  role: "owner" | "editor" | "viewer" | "helper",
  addedBy = osnProfileId,
): void {
  db.insert(weddingHosts)
    .values({
      id: `whost_${weddingId}_${osnProfileId}`,
      weddingId,
      osnProfileId,
      addedByOsnProfileId: addedBy,
      role,
      createdAt: new Date(NOW.getTime() - 30 * DAY_S * 1000),
    })
    .run();
}

function wedding(
  db: TestDb,
  id: string,
  owners: readonly string[],
  opts: { name?: string; deletedAt?: Date | null } = {},
): void {
  insertWedding(db, {
    id,
    slug: `slug-${id}`,
    displayName: opts.name ?? `Wedding ${id}`,
    owners,
    createdAt: new Date(NOW.getTime() - 60 * DAY_S * 1000),
    deletedAt: opts.deletedAt ?? null,
  });
}

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));

const preview = (db: TestDb, profileIds: readonly string[] = [P], origin = PORTAL) =>
  run(
    db,
    accountErasureService.preview({
      profileIds,
      deletesAt: NOW_S,
      organiserOrigin: origin,
    }),
  );

function erase(db: TestDb, opts: { profileIds?: readonly string[]; now?: Date } = {}) {
  const result = run(
    db,
    accountErasureService.erase({
      accountId: ACCOUNT,
      profileIds: opts.profileIds ?? [P],
      now: opts.now ?? NOW,
    }),
  );
  return { result };
}

/** What the erasure did to the weddings the person owned, as its metric counts them. */
const weddingOutcomes = async () => ({
  deleted: await counterValue(CIRE_METRICS.accountDeletionWeddings, { outcome: "deleted" }),
  seatRemoved: await counterValue(CIRE_METRICS.accountDeletionWeddings, {
    outcome: "seat_removed",
  }),
});

const seatsOf = (db: TestDb, weddingId: string) =>
  db
    .select({ profile: weddingHosts.osnProfileId, role: weddingHosts.role })
    .from(weddingHosts)
    .where(eq(weddingHosts.weddingId, weddingId))
    .all();

const weddingRow = (db: TestDb, id: string) =>
  db.select().from(weddings).where(eq(weddings.id, id)).all()[0];

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("accountErasureService.preview", () => {
  it("F8: a live wedding the account alone owns is one action: delete, no default, and a link to its owners", async () => {
    const db = makeDb();
    wedding(db, "w1", [P], { name: "Ama & Jonah" });
    seat(db, "w1", EDITOR, "editor", P);

    expect(await preview(db)).toEqual([
      {
        id: "cire:wedding:w1",
        kind: "wedding_sole_owner",
        label: expect.stringContaining('"Ama & Jonah"'),
        choices: [{ choice: "delete", description: expect.any(String), erasedOn: null }],
        defaultChoice: null,
        link: `${PORTAL}/#/w/w1/settings/hosts`,
      },
    ]);
  });

  it("F9, F11, F12: a wedding with another owner, a deleted one, and a lower seat need no answer", async () => {
    const db = makeDb();
    wedding(db, "w_shared", [P, OTHER]);
    wedding(db, "w_deleted", [P], { deletedAt: new Date(NOW.getTime() - DAY_S * 1000) });
    wedding(db, "w_editor", [OTHER]);
    seat(db, "w_editor", P, "editor", OTHER);
    expect(await preview(db)).toEqual([]);
  });

  it("F10: every owner seat being one of the account's own profiles is sole ownership", async () => {
    const db = makeDb();
    wedding(db, "w1", [P, P2]);
    const actions = await preview(db, [P, P2]);
    expect(actions.map((a) => [a.id, a.kind])).toEqual([["cire:wedding:w1", "wedding_sole_owner"]]);
  });

  it("F13: past a hundred weddings the account alone owns, one action stands for them all", async () => {
    const db = makeDb();
    for (let i = 0; i < 101; i += 1) wedding(db, `w${String(i).padStart(3, "0")}`, [P]);
    const actions = await preview(db);
    expect(actions).toEqual([
      {
        id: "cire:weddings:all",
        kind: "weddings_sole_owner",
        label: expect.any(String),
        choices: [{ choice: "delete", description: expect.any(String), erasedOn: null }],
        defaultChoice: null,
        link: `${PORTAL}/`,
      },
    ]);
  });

  it("F13: a hundred weddings the account alone owns are listed one by one", async () => {
    const db = makeDb();
    for (let i = 0; i < 100; i += 1) wedding(db, `w${String(i).padStart(3, "0")}`, [P]);
    const actions = await preview(db);
    expect(actions).toHaveLength(100);
    expect(actions.every((a) => a.kind === "wedding_sole_owner")).toBe(true);
  });

  it.each([["http://localhost:4322"], ["not an origin"]])(
    "F14: an organiser portal that is not https (%s) gives no link",
    async (origin) => {
      const db = makeDb();
      wedding(db, "w1", [P]);
      const [action] = await preview(db, [P], origin);
      expect(action?.link).toBeNull();
    },
  );

  it("F44: a long wedding name stays inside the contract's 500 characters", async () => {
    const db = makeDb();
    wedding(db, "w1", [P], { name: "y".repeat(600) });
    const [action] = await preview(db);
    expect(action?.label.length).toBeLessThanOrEqual(500);
    expect(action?.label).toContain(`"${"y".repeat(120)}…"`);
    expect(action?.choices[0]?.description.length).toBeLessThanOrEqual(500);
  });

  it("F44: a name at its write-time limit of 120 characters is quoted whole", async () => {
    const db = makeDb();
    wedding(db, "w1", [P], { name: "z".repeat(120) });
    const [action] = await preview(db);
    expect(action?.label).toContain(`"${"z".repeat(120)}"`);
  });

  it("an account with no profiles has nothing open", async () => {
    const db = makeDb();
    wedding(db, "w1", [P]);
    expect(await preview(db, [])).toEqual([]);
  });

  it("a failed read fails the preview, for the route to answer 500", async () => {
    const db = makeDb();
    wedding(db, "w1", [P]);
    failStatements(db, (statement) => /from "wedding_hosts"/i.test(statement));
    const exit = await Effect.runPromiseExit(
      accountErasureService
        .preview({ profileIds: [P], deletesAt: NOW_S, organiserOrigin: PORTAL })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(exit._tag).toBe("Failure");
  });
});

// ---------------------------------------------------------------------------
// Erase: the weddings the person owns
// ---------------------------------------------------------------------------

/** Every live wedding with no owner seat: always none. */
const liveWithNoOwner = (db: TestDb) =>
  db
    .all<{ id: string }>(
      sql.raw(
        "SELECT id FROM weddings w WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM wedding_hosts h WHERE h.wedding_id = w.id AND h.role = 'owner')",
      ),
    )
    .map((row) => row.id);

describe("accountErasureService.erase — weddings the person owns", () => {
  // The person's answers never reach this service: whatever they answered,
  // or if they answered nothing (F15, F16, F17), the rows decide. The route
  // test sends each form.
  it("F15, F16, F17: a wedding the person alone owns is deleted with their seat", async () => {
    const db = makeDb();
    wedding(db, "w1", [P]);
    seat(db, "w1", EDITOR, "editor", P);
    db.insert(hostRsvpNotices).values({ weddingId: "w1", osnProfileId: P, updatedAt: NOW }).run();
    const before = await weddingOutcomes();

    expect(await erase(db).result).toEqual({ status: "done", kept: [] });

    const row = weddingRow(db, "w1");
    expect(row?.deletedAt).toEqual(NOW);
    expect(row?.deletedByOsnProfileId).toBeNull();
    expect(seatsOf(db, "w1")).toEqual([{ profile: EDITOR, role: "editor" }]);
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);
    expect(liveWithNoOwner(db)).toEqual([]);
    expect(await weddingOutcomes()).toEqual({
      deleted: before.deleted + 1,
      seatRemoved: before.seatRemoved,
    });
  });

  it("F10: a wedding whose owners are all the account's profiles is deleted, every seat with it", async () => {
    const db = makeDb();
    wedding(db, "w1", [P, P2]);
    expect(await erase(db, { profileIds: [P, P2] }).result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([]);
    expect(weddingRow(db, "w1")?.deletedAt).toEqual(NOW);
    expect(liveWithNoOwner(db)).toEqual([]);
  });

  it("F19: a wedding with another owner loses the person's seat and nothing else", async () => {
    const db = makeDb();
    wedding(db, "w1", [P, OTHER]);
    db.insert(hostRsvpNotices).values({ weddingId: "w1", osnProfileId: P, updatedAt: NOW }).run();
    const before = await weddingOutcomes();
    const { result } = erase(db);
    expect(await result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([{ profile: OTHER, role: "owner" }]);
    expect(weddingRow(db, "w1")?.deletedAt).toBeNull();
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);
    expect(await weddingOutcomes()).toEqual({
      deleted: before.deleted,
      seatRemoved: before.seatRemoved + 1,
    });
  });

  it("F20: the other owner leaving before the batch makes the person the only owner: deleted", async () => {
    const db = makeDb();
    wedding(db, "w1", [P, OTHER]);
    beforeStatement(db, /delete from "host_rsvp_notices"/i, () => {
      db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, OTHER)).run();
    });
    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([]);
    expect(weddingRow(db, "w1")?.deletedAt).toEqual(NOW);
    expect(liveWithNoOwner(db)).toEqual([]);
  });

  it("F21: a repeat call writes nothing more and answers the same", async () => {
    const db = makeDb();
    wedding(db, "w1", [P]);
    wedding(db, "w2", [P, OTHER]);
    const first = await erase(db).result;
    expect(await erase(db, { now: new Date(NOW.getTime() + 60_000) }).result).toEqual(first);
    // The delete time is the first call's.
    expect(weddingRow(db, "w1")?.deletedAt).toEqual(NOW);
    expect(seatsOf(db, "w2")).toEqual([{ profile: OTHER, role: "owner" }]);
  });

  it("F22: past the per-call cap, the call does part of the work and answers not finished", async () => {
    const db = makeDb();
    const count = MAX_OWNED_WEDDINGS_PER_CALL + 1;
    for (let i = 0; i < count; i += 1) wedding(db, `w${i}`, [P, OTHER]);
    db.insert(organiserSessions)
      .values({
        id: "oss_1",
        token: "tok_1",
        osnProfileId: P,
        osnSub: "sub",
        expiresAt: new Date(NOW.getTime() + DAY_S * 1000),
        createdAt: NOW,
      })
      .run();

    expect(await erase(db).result).toEqual({ status: "not_finished" });
    // The cap's worth of weddings lost the seat; the rest, and the account's
    // own rows, wait for the call that finishes.
    const stillSeated = Array.from({ length: count }, (_, i) => `w${i}`).filter((id) =>
      seatsOf(db, id).some((s) => s.profile === P),
    );
    expect(stillSeated).toHaveLength(count - MAX_OWNED_WEDDINGS_PER_CALL);
    expect(db.select().from(organiserSessions).all()).toHaveLength(1);

    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
    expect(db.select().from(organiserSessions).all()).toEqual([]);
    for (let i = 0; i < count; i += 1) {
      expect(seatsOf(db, `w${i}`)).toEqual([{ profile: OTHER, role: "owner" }]);
    }
  });

  it("F22: exactly the per-call cap of weddings finishes in one call", async () => {
    const db = makeDb();
    for (let i = 0; i < MAX_OWNED_WEDDINGS_PER_CALL; i += 1) wedding(db, `w${i}`, [P, OTHER]);
    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
  });

  it("F22: a call at the cap stays inside the 50 D1 queries one Worker invocation may make", async () => {
    const db = makeDb();
    for (let i = 0; i < MAX_OWNED_WEDDINGS_PER_CALL; i += 1) wedding(db, `w${i}`, [P]);
    const statements = recordStatements(db);
    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
    // 1 read of owned weddings + 3 per wedding + 22 in the account's clean-up.
    expect(statements).toHaveLength(1 + 3 * MAX_OWNED_WEDDINGS_PER_CALL + 22);
    expect(statements.length).toBeLessThanOrEqual(50);
  });

  // Each case fails a batch's first statement: on bun:sqlite a batch is not
  // atomic, and on D1 a failed batch writes nothing.
  it.each([
    ["a wedding's batch", /delete from "host_rsvp_notices"/i],
    ["the account's clean-up", /delete from "host_rsvp_notices" where .*NOT EXISTS/i],
    ["the read of owned weddings", /^select .* from "wedding_hosts"/i],
  ])("a failed statement in %s fails the call, and the next call finishes", async (_l, pattern) => {
    const db = makeDb();
    wedding(db, "w1", [P]);
    const failing = failStatements(db, (statement) => pattern.test(statement));
    const exit = await Effect.runPromiseExit(
      accountErasureService
        .erase({ accountId: ACCOUNT, profileIds: [P], now: NOW })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(exit._tag).toBe("Failure");
    expect(failing.failed()).toBeGreaterThan(0);
    failing.restore();
    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([]);
    expect(weddingRow(db, "w1")?.deletedAt).toEqual(NOW);
  });

  it("F28: a deleted wedding the person alone owned loses the seat and stays deleted from its own time", async () => {
    const db = makeDb();
    const deletedAt = new Date(NOW.getTime() - DAY_S * 1000);
    wedding(db, "w1", [P], { deletedAt });
    expect(await erase(db).result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([]);
    expect(weddingRow(db, "w1")?.deletedAt).toEqual(deletedAt);
  });

  it("F41: a seat below owner goes, on a wedding with an owner, with no wedding batch", async () => {
    const db = makeDb();
    wedding(db, "w1", [OTHER]);
    seat(db, "w1", P, "helper", OTHER);
    const { result } = erase(db);
    expect(await result).toEqual({ status: "done", kept: [] });
    expect(seatsOf(db, "w1")).toEqual([{ profile: OTHER, role: "owner" }]);
    expect(weddingRow(db, "w1")?.deletedAt).toBeNull();
  });

  it("F42: a notice row with no seat behind it goes", async () => {
    const db = makeDb();
    wedding(db, "w_left", [OTHER]);
    db.insert(hostRsvpNotices)
      .values({ weddingId: "w_left", osnProfileId: P, updatedAt: NOW })
      .run();
    await erase(db).result;
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);
  });

  it("F42: a seat made owner after the pre-read keeps its notice row, and the call is not finished", async () => {
    const db = makeDb();
    wedding(db, "w1", [OTHER]);
    seat(db, "w1", P, "editor", OTHER);
    db.insert(hostRsvpNotices).values({ weddingId: "w1", osnProfileId: P, updatedAt: NOW }).run();
    // The pre-read finds no owner seat; another owner promotes the person
    // before the account's clean-up runs.
    beforeStatement(db, /delete from "host_rsvp_notices"/i, () => {
      db.update(weddingHosts).set({ role: "owner" }).where(eq(weddingHosts.osnProfileId, P)).run();
    });

    expect(await erase(db).result).toEqual({ status: "not_finished" });
    expect(seatsOf(db, "w1").toSorted((a, b) => a.profile.localeCompare(b.profile))).toEqual([
      { profile: P, role: "owner" },
      { profile: OTHER, role: "owner" },
    ]);
    expect(db.select().from(hostRsvpNotices).all()).toHaveLength(1);

    // The next call takes the owner seat through its wedding's own batch.
    expect((await erase(db).result).status).toBe("done");
    expect(seatsOf(db, "w1")).toEqual([{ profile: OTHER, role: "owner" }]);
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Erase: the account's own rows and its name on other people's
// ---------------------------------------------------------------------------

/** One value of `column` in `table`, by the row's key. */
const valueOf = (db: TestDb, table: string, column: string, where: string) =>
  db.all<Record<string, unknown>>(sql.raw(`SELECT ${column} AS v FROM ${table} WHERE ${where}`))[0]
    ?.v;

/**
 * Every column that can name an organiser's OSN profile, with what the
 * erasure leaves in it. The wedding `wed_attr` is owned by someone else; the
 * erased profile's id is written into each column on it.
 */
const ATTRIBUTION: ReadonlyArray<
  readonly [table: string, column: string, where: string, after: unknown]
> = [
  ["weddings", "updated_by_osn_profile_id", "id = 'wed_attr'", null],
  ["weddings", "deleted_by_osn_profile_id", "id = 'wed_attr'", null],
  ["guests", "email_attested_by_osn_profile_id", "id = 'gst_wed_attr'", null],
  ["directory_vendors", "claimed_by_profile_id", "id = 'dv_wed_attr'", null],
  ["directory_vendors", "review_profile_id", "id = 'dv_wed_attr'", null],
  ["directory_vendors", "review_org_id", "id = 'dv_wed_attr'", null],
  ["directory_vendors", "review_requested_at", "id = 'dv_wed_attr'", null],
  ["registry_settings", "stripe_connected_by_osn_profile_id", "wedding_id = 'wed_attr'", null],
  ["registry_claims", "thanked_by", "id = 'rclm_wed_attr'", DELETED],
  ["registry_claims", "note_hidden_by_osn_profile_id", "id = 'rclm_wed_attr'", DELETED],
  ["registry_contributions", "thanked_by", "id = 'rcon_wed_attr'", DELETED],
  ["registry_contributions", "note_hidden_by_osn_profile_id", "id = 'rcon_wed_attr'", DELETED],
  ["rsvps", "recorded_by_osn_profile_id", "id = 'rsvp_wed_attr'", null],
  ["rsvps", "dietary_attested_by_osn_profile_id", "id = 'rsvp_wed_attr'", null],
  ["rsvp_changes", "actor_osn_profile_id", "wedding_id = 'wed_attr'", ""],
  ["unlock_code_redemptions", "redeemed_by_osn_profile_id", "id = 'ulr_wed_attr'", null],
  ["wedding_hosts", "added_by_osn_profile_id", "id = 'whost_wed_attr'", DELETED],
  ["vendor_enquiries", "created_by", "id = 'enq_wed_attr'", DELETED],
  ["wedding_upgrade_purchases", "created_by_osn_profile_id", "id = 'upg_wed_attr'", DELETED],
];

function seedAttribution(db: TestDb, weddingId: string, profile: string): void {
  for (const statement of fullWeddingStatements(weddingId, { owner: OTHER, now: NOW })) {
    db.run(statement);
  }
  const w = weddingId;
  const s = NOW_S;
  for (const statement of [
    `UPDATE weddings SET updated_by_osn_profile_id = '${profile}', deleted_by_osn_profile_id = '${profile}' WHERE id = '${w}'`,
    `UPDATE guests SET email_attested_by_osn_profile_id = '${profile}' WHERE id = 'gst_${w}'`,
    `UPDATE directory_vendors SET claimed_by_profile_id = '${profile}', owner_org_id = 'org_v_${w}', review_org_id = 'org_r_${w}', review_profile_id = '${profile}', review_requested_at = ${s} WHERE id = 'dv_${w}'`,
    `UPDATE registry_settings SET stripe_connected_by_osn_profile_id = '${profile}' WHERE wedding_id = '${w}'`,
    `UPDATE registry_claims SET thanked_at = ${s}, thanked_by = '${profile}', note_hidden_at = ${s}, note_hidden_by_osn_profile_id = '${profile}' WHERE id = 'rclm_${w}'`,
    `UPDATE registry_contributions SET thanked_at = ${s}, thanked_by = '${profile}', note_hidden_at = ${s}, note_hidden_by_osn_profile_id = '${profile}' WHERE id = 'rcon_${w}'`,
    `UPDATE rsvps SET recorded_by_osn_profile_id = '${profile}', dietary_attested_by_osn_profile_id = '${profile}' WHERE id = 'rsvp_${w}'`,
    `UPDATE rsvp_changes SET actor_osn_profile_id = '${profile}' WHERE wedding_id = '${w}'`,
    `UPDATE unlock_code_redemptions SET redeemed_by_osn_profile_id = '${profile}' WHERE id = 'ulr_${w}'`,
    `UPDATE wedding_hosts SET added_by_osn_profile_id = '${profile}' WHERE id = 'whost_${w}'`,
    `UPDATE vendor_enquiries SET created_by = '${profile}', zap_chat_id = 'chat_${w}' WHERE id = 'enq_${w}'`,
    `UPDATE wedding_upgrade_purchases SET created_by_osn_profile_id = '${profile}' WHERE id = 'upg_${w}'`,
  ]) {
    db.run(sql.raw(statement));
  }
}

describe("accountErasureService.erase — the account's own rows and its name on others' (F24)", () => {
  it("clears every column that names the person, and only theirs", async () => {
    const db = makeDb();
    seedAttribution(db, "wed_attr", P);
    seedAttribution(db, "wed_ctrl", "usr_someone_else");

    expect(await erase(db).result).toEqual({ status: "done", kept: [] });

    for (const [table, column, where, after] of ATTRIBUTION) {
      expect({ table, column, value: valueOf(db, table, column, where) }).toEqual({
        table,
        column,
        value: after,
      });
      const control = valueOf(db, table, column, where.replace("wed_attr", "wed_ctrl"));
      expect({ table, column, control: control === null ? null : "kept" }).toEqual({
        table,
        column,
        control: "kept",
      });
    }
    // The listing itself stays, with its organisation.
    expect(valueOf(db, "directory_vendors", "owner_org_id", "id = 'dv_wed_attr'")).toBe(
      "org_v_wed_attr",
    );
    // The timestamps the sentinel stands beside stay.
    expect(valueOf(db, "registry_claims", "note_hidden_at", "id = 'rclm_wed_attr'")).toBe(NOW_S);
  });

  it("deletes the person's sessions, links, Stripe states and budgets, and no one else's", async () => {
    const db = makeDb();
    for (const statement of fullWeddingStatements("wed_a", { owner: OTHER, now: NOW })) {
      db.run(statement);
    }
    db.run(
      sql.raw(
        `UPDATE guest_account_links SET osn_account_id = '${ACCOUNT}', osn_profile_id = 'usr_any' WHERE id = 'gal_wed_a'`,
      ),
    );
    db.run(
      sql.raw(
        `UPDATE registry_stripe_oauth_states SET osn_profile_id = '${P}' WHERE wedding_id = 'wed_a'`,
      ),
    );
    for (const profile of [P, OTHER]) {
      db.insert(organiserSessions)
        .values({
          id: `oss_${profile}`,
          token: `tok_${profile}`,
          osnProfileId: profile,
          osnSub: "sub",
          expiresAt: new Date(NOW.getTime() + DAY_S * 1000),
          createdAt: NOW,
        })
        .run();
      db.insert(realtimeSubscribeBudget).values({ osnProfileId: profile, day: "2026-11-16" }).run();
      db.insert(ownerNoticeBudget)
        .values({ key: `actor:${profile}`, day: "2026-11-16" })
        .run();
    }
    db.insert(ownerNoticeBudget).values({ key: "wedding:wed_a", day: "2026-11-16" }).run();

    await erase(db).result;

    expect(db.select({ p: organiserSessions.osnProfileId }).from(organiserSessions).all()).toEqual([
      { p: OTHER },
    ]);
    expect(valueOf(db, "guest_account_links", "count(*)", "1 = 1")).toBe(0);
    expect(valueOf(db, "registry_stripe_oauth_states", "count(*)", "1 = 1")).toBe(0);
    expect(
      db.select({ p: realtimeSubscribeBudget.osnProfileId }).from(realtimeSubscribeBudget).all(),
    ).toEqual([{ p: OTHER }]);
    expect(
      db
        .select({ key: ownerNoticeBudget.key })
        .from(ownerNoticeBudget)
        .all()
        .map((r) => r.key)
        .toSorted(),
    ).toEqual([`actor:${OTHER}`, "wedding:wed_a"]);
  });

  it("F27: a guest account link of the person's profile goes too, whatever account it names", async () => {
    const db = makeDb();
    for (const statement of fullWeddingStatements("wed_a", { owner: OTHER, now: NOW })) {
      db.run(statement);
    }
    db.run(
      sql.raw(
        `UPDATE guest_account_links SET osn_account_id = 'acc_other', osn_profile_id = '${P}' WHERE id = 'gal_wed_a'`,
      ),
    );
    await erase(db).result;
    expect(valueOf(db, "guest_account_links", "count(*)", "1 = 1")).toBe(0);
  });

  it("F25: an enquiry the person opened that never reached a chat is deleted; a sent one stays", async () => {
    const db = makeDb();
    for (const statement of fullWeddingStatements("wed_a", { owner: OTHER, now: NOW })) {
      db.run(statement);
    }
    for (const statement of fullWeddingStatements("wed_b", { owner: OTHER, now: NOW })) {
      db.run(statement);
    }
    db.run(
      sql.raw(
        `UPDATE vendor_enquiries SET created_by = '${P}', pending_body = 'Hello', zap_chat_id = NULL WHERE id = 'enq_wed_a'`,
      ),
    );
    db.run(
      sql.raw(
        `UPDATE vendor_enquiries SET created_by = '${P}', pending_body = NULL, zap_chat_id = 'chat_b' WHERE id = 'enq_wed_b'`,
      ),
    );

    await erase(db).result;

    expect(valueOf(db, "vendor_enquiries", "count(*)", "id = 'enq_wed_a'")).toBe(0);
    // The wedding's own record of the vendor stays.
    expect(valueOf(db, "vendors", "count(*)", "id = 'ven_wed_a'")).toBe(1);
    expect(valueOf(db, "vendor_enquiries", "created_by", "id = 'enq_wed_b'")).toBe(DELETED);
  });

  it("an account with no profiles still loses the guest account links that name it", async () => {
    const db = makeDb();
    for (const statement of fullWeddingStatements("wed_a", { owner: OTHER, now: NOW })) {
      db.run(statement);
    }
    db.run(
      sql.raw(
        `UPDATE guest_account_links SET osn_account_id = '${ACCOUNT}', osn_profile_id = 'usr_any' WHERE id = 'gal_wed_a'`,
      ),
    );
    expect(await erase(db, { profileIds: [] }).result).toEqual({ status: "done", kept: [] });
    expect(db.select().from(guestAccountLinks).all()).toEqual([]);
    expect(seatsOf(db, "wed_a")).toEqual([{ profile: OTHER, role: "owner" }]);
  });

  it("F26: a vendor claim the person was waiting on is cleared whole", async () => {
    const db = makeDb();
    db.insert(directoryVendors)
      .values({
        id: "dv_pending",
        name: "Florist",
        reviewOrgId: "org_waiting",
        reviewProfileId: P,
        reviewRequestedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    await erase(db).result;
    const [row] = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, "dv_pending"))
      .all();
    expect([row?.reviewOrgId, row?.reviewProfileId, row?.reviewRequestedAt]).toEqual([
      null,
      null,
      null,
    ]);
  });
});
