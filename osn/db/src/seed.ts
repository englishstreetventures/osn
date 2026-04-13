import { Effect, Data } from "effect";

import {
  accounts,
  users,
  connections,
  closeFriends,
  organisations,
  organisationMembers,
} from "./schema";
import type {
  NewAccount,
  NewUser,
  NewConnection,
  NewCloseFriend,
  NewOrganisation,
  NewOrganisationMember,
} from "./schema";
import { DbLive, Db } from "./service";

class SeedError extends Data.TaggedError("SeedError")<{ cause: unknown }> {}

// ---------------------------------------------------------------------------
// Seed accounts (21 total — 20 single-profile + 1 multi-profile)
// ---------------------------------------------------------------------------

export function buildSeedAccounts(now: Date): NewAccount[] {
  const acc = (name: string): NewAccount => ({
    id: `acc_seed_${name}`,
    email: `${name}@seed.osn.dev`,
    maxProfiles: 5,
    createdAt: now,
    updatedAt: now,
  });

  return [
    acc("me"),
    acc("alice"),
    acc("bob"),
    acc("charlie"),
    acc("dana"),
    acc("eli"),
    acc("faye"),
    acc("george"),
    acc("hana"),
    acc("ivan"),
    acc("jess"),
    acc("kai"),
    acc("luna"),
    acc("milo"),
    acc("nina"),
    acc("omar"),
    acc("priya"),
    acc("quinn"),
    acc("rosa"),
    acc("sam"),
    // Multi-account user — exercises the many-profiles-per-account model
    acc("multi"),
  ];
}

// ---------------------------------------------------------------------------
// Seed users / profiles (23 total — 20 original 1:1 + 3 multi)
// ---------------------------------------------------------------------------

/**
 * Seed profiles for development and testing.
 *
 * usr_seed_me is the authenticated dev user placeholder.
 * All other profiles form a realistic social graph around "me".
 *
 * acc_seed_multi owns 3 profiles to exercise multi-account features:
 *   usr_seed_multi_main (default), usr_seed_multi_alt, usr_seed_multi_work
 */
export function buildSeedUsers(now: Date): NewUser[] {
  /** Shorthand: single-profile account (1:1 mapping) */
  const solo = (name: string, displayName: string): NewUser => ({
    id: `usr_seed_${name}`,
    accountId: `acc_seed_${name}`,
    handle: name,
    displayName,
    avatarUrl: null,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });

  return [
    // ── Core trio ─────────────────────────────────────────────────────────
    solo("me", "You (seed)"),
    solo("alice", "Alice Chen"),
    solo("bob", "Bob Martinez"),

    // ── Close friends of "me" ─────────────────────────────────────────────
    solo("charlie", "Charlie Park"),
    solo("dana", "Dana Rivera"),
    solo("eli", "Eli Nakamura"),

    // ── Extended friend circle ────────────────────────────────────────────
    solo("faye", "Faye Okonkwo"),
    solo("george", "George Kim"),
    solo("hana", "Hana Petrov"),
    solo("ivan", "Ivan Torres"),
    solo("jess", "Jess Albright"),

    // ── Friends of friends (not directly connected to "me") ───────────────
    solo("kai", "Kai Sørensen"),
    solo("luna", "Luna Vasquez"),
    solo("milo", "Milo Zhang"),
    solo("nina", "Nina Johansson"),

    // ── Strangers (no connection to "me") ─────────────────────────────────
    solo("omar", "Omar Farouk"),
    solo("priya", "Priya Sharma"),
    solo("quinn", "Quinn O'Brien"),
    solo("rosa", "Rosa Delgado"),
    solo("sam", "Sam Oduya"),

    // ── Multi-account profiles (acc_seed_multi owns all three) ────────────
    {
      id: "usr_seed_multi_main",
      accountId: "acc_seed_multi",
      handle: "multi_main",

      displayName: "Multi Main",
      avatarUrl: null,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_multi_alt",
      accountId: "acc_seed_multi",
      handle: "multi_alt",

      displayName: "Multi Alt",
      avatarUrl: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_multi_work",
      accountId: "acc_seed_multi",
      handle: "multi_work",

      displayName: "Multi Work",
      avatarUrl: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// ---------------------------------------------------------------------------
// Seed connections
// ---------------------------------------------------------------------------

/**
 * Builds the social graph.
 *
 * "me" is connected to 8 people (alice, bob, charlie, dana, eli, faye, george, hana).
 * alice↔bob, charlie↔dana, eli↔faye, george↔hana form cross-links.
 * A few pending requests exist too.
 * Friends-of-friends (kai, luna, milo, nina) connect to alice/bob but NOT to "me".
 * Strangers (omar, priya, quinn, rosa, sam) have no path to "me".
 * Multi-account profiles have cross-profile and same-account connections.
 */
export function buildSeedConnections(now: Date): NewConnection[] {
  let i = 0;
  const conn = (
    a: string,
    b: string,
    status: "accepted" | "pending" = "accepted",
  ): NewConnection => ({
    id: `conn_seed_${++i}`,
    requesterId: a,
    addresseeId: b,
    status,
    createdAt: now,
    updatedAt: now,
  });

  const ME = "usr_seed_me";
  const ALICE = "usr_seed_alice";
  const BOB = "usr_seed_bob";
  const CHARLIE = "usr_seed_charlie";
  const DANA = "usr_seed_dana";
  const ELI = "usr_seed_eli";
  const FAYE = "usr_seed_faye";
  const GEORGE = "usr_seed_george";
  const HANA = "usr_seed_hana";
  const IVAN = "usr_seed_ivan";
  const JESS = "usr_seed_jess";
  const KAI = "usr_seed_kai";
  const LUNA = "usr_seed_luna";
  const MILO = "usr_seed_milo";
  const NINA = "usr_seed_nina";
  const OMAR = "usr_seed_omar";
  const PRIYA = "usr_seed_priya";
  const MULTI_MAIN = "usr_seed_multi_main";
  const MULTI_ALT = "usr_seed_multi_alt";

  return [
    // ── "me" ↔ direct friends (accepted) ──────────────────────────────────
    conn(ME, ALICE),
    conn(ME, BOB),
    conn(ME, CHARLIE),
    conn(ME, DANA),
    conn(ME, ELI),
    conn(FAYE, ME), // Faye requested, me accepted
    conn(GEORGE, ME),
    conn(HANA, ME),

    // ── "me" — pending requests ───────────────────────────────────────────
    conn(IVAN, ME, "pending"), // Ivan wants to connect, me hasn't accepted
    conn(ME, JESS, "pending"), // me requested, Jess hasn't accepted

    // ── Cross-links between me's friends ──────────────────────────────────
    conn(ALICE, BOB),
    conn(CHARLIE, DANA),
    conn(ELI, FAYE),
    conn(GEORGE, HANA),
    conn(ALICE, CHARLIE),
    conn(BOB, ELI),
    conn(DANA, GEORGE),

    // ── Friends-of-friends (connected to alice/bob, NOT to me) ────────────
    conn(ALICE, KAI),
    conn(ALICE, LUNA),
    conn(BOB, MILO),
    conn(BOB, NINA),
    conn(KAI, LUNA),
    conn(MILO, NINA),

    // ── Stranger connections (isolated from "me") ─────────────────────────
    conn(OMAR, PRIYA),
    conn(OMAR, NINA), // omar knows nina through bob's circle, but not me

    // ── Multi-account cross-profile connections ───────────────────────────
    conn(ALICE, MULTI_MAIN), // alice knows multi's main profile
    conn(BOB, MULTI_ALT), // bob knows multi's alt profile
    conn(MULTI_MAIN, MULTI_ALT), // two profiles of same account can interact
  ];
}

// ---------------------------------------------------------------------------
// Seed close friends
// ---------------------------------------------------------------------------

export function buildSeedCloseFriends(now: Date): NewCloseFriend[] {
  const ME = "usr_seed_me";
  return [
    { id: "clf_seed_1", profileId: ME, friendId: "usr_seed_alice", createdAt: now },
    { id: "clf_seed_2", profileId: ME, friendId: "usr_seed_charlie", createdAt: now },
    { id: "clf_seed_3", profileId: ME, friendId: "usr_seed_dana", createdAt: now },
  ];
}

// ---------------------------------------------------------------------------
// Seed organisations
// ---------------------------------------------------------------------------

export function buildSeedOrganisations(now: Date): NewOrganisation[] {
  return [
    {
      id: "org_seed_club",
      handle: "seedclub",
      name: "Seed Club",
      description: "A community org for seed data testing",
      avatarUrl: null,
      ownerId: "usr_seed_alice",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "org_seed_work",
      handle: "seedwork",
      name: "Seed Workplace",
      description: "A workplace org owned by a multi-account profile",
      avatarUrl: null,
      ownerId: "usr_seed_multi_work",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// ---------------------------------------------------------------------------
// Seed organisation members
// ---------------------------------------------------------------------------

export function buildSeedOrgMembers(now: Date): NewOrganisationMember[] {
  return [
    // ── Seed Club — owned by alice, bob + multi_main as members ───────────
    {
      id: "orgm_seed_1",
      organisationId: "org_seed_club",
      profileId: "usr_seed_alice",
      role: "admin" as const,
      createdAt: now,
    },
    {
      id: "orgm_seed_2",
      organisationId: "org_seed_club",
      profileId: "usr_seed_bob",
      role: "member" as const,
      createdAt: now,
    },
    {
      id: "orgm_seed_3",
      organisationId: "org_seed_club",
      profileId: "usr_seed_multi_main",
      role: "member" as const,
      createdAt: now,
    },

    // ── Seed Workplace — owned by multi_work, charlie + multi_alt as members
    // Tests: multiple profiles from same account in same org
    {
      id: "orgm_seed_4",
      organisationId: "org_seed_work",
      profileId: "usr_seed_multi_work",
      role: "admin" as const,
      createdAt: now,
    },
    {
      id: "orgm_seed_5",
      organisationId: "org_seed_work",
      profileId: "usr_seed_charlie",
      role: "member" as const,
      createdAt: now,
    },
    {
      id: "orgm_seed_6",
      organisationId: "org_seed_work",
      profileId: "usr_seed_multi_alt",
      role: "member" as const,
      createdAt: now,
    },
  ];
}

// ---------------------------------------------------------------------------
// Run seed
// ---------------------------------------------------------------------------

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

  yield* Effect.tryPromise({
    try: () => db.insert(accounts).values(buildSeedAccounts(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(users).values(buildSeedUsers(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(connections).values(buildSeedConnections(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(closeFriends).values(buildSeedCloseFriends(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(organisations).values(buildSeedOrganisations(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () =>
      db.insert(organisationMembers).values(buildSeedOrgMembers(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  // eslint-disable-next-line no-console -- CLI seed script output
  console.log(
    "Seed complete — 21 accounts, 23 profiles, 28 connections, 3 close friends, 2 orgs, 6 org members inserted (existing rows skipped).",
  );
}).pipe(Effect.provide(DbLive));

// eslint-disable-next-line no-console -- CLI seed script error handler
Effect.runPromise(seed).catch(console.error);
