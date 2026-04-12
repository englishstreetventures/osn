import { Effect, Data } from "effect";

import { users, connections, closeFriends } from "./schema";
import type { NewUser, NewConnection, NewCloseFriend } from "./schema";
import { DbLive, Db } from "./service";

class SeedError extends Data.TaggedError("SeedError")<{ cause: unknown }> {}

// ---------------------------------------------------------------------------
// Seed users (20 total)
// ---------------------------------------------------------------------------

/**
 * Seed users for development and testing.
 *
 * usr_seed_me is the authenticated dev user placeholder.
 * All other users form a realistic social graph around "me".
 */
export function buildSeedUsers(now: Date): NewUser[] {
  return [
    // ── Core trio (original) ──────────────────────────────────────────────
    {
      id: "usr_seed_me",
      handle: "me",
      email: "me@seed.osn.dev",
      displayName: "You (seed)",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_alice",
      handle: "alice",
      email: "alice@seed.osn.dev",
      displayName: "Alice Chen",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_bob",
      handle: "bob",
      email: "bob@seed.osn.dev",
      displayName: "Bob Martinez",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },

    // ── Close friends of "me" ─────────────────────────────────────────────
    {
      id: "usr_seed_charlie",
      handle: "charlie",
      email: "charlie@seed.osn.dev",
      displayName: "Charlie Park",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_dana",
      handle: "dana",
      email: "dana@seed.osn.dev",
      displayName: "Dana Rivera",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_eli",
      handle: "eli",
      email: "eli@seed.osn.dev",
      displayName: "Eli Nakamura",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },

    // ── Extended friend circle ────────────────────────────────────────────
    {
      id: "usr_seed_faye",
      handle: "faye",
      email: "faye@seed.osn.dev",
      displayName: "Faye Okonkwo",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_george",
      handle: "george",
      email: "george@seed.osn.dev",
      displayName: "George Kim",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_hana",
      handle: "hana",
      email: "hana@seed.osn.dev",
      displayName: "Hana Petrov",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_ivan",
      handle: "ivan",
      email: "ivan@seed.osn.dev",
      displayName: "Ivan Torres",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_jess",
      handle: "jess",
      email: "jess@seed.osn.dev",
      displayName: "Jess Albright",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },

    // ── Friends of friends (not directly connected to "me") ───────────────
    {
      id: "usr_seed_kai",
      handle: "kai",
      email: "kai@seed.osn.dev",
      displayName: "Kai Sørensen",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_luna",
      handle: "luna",
      email: "luna@seed.osn.dev",
      displayName: "Luna Vasquez",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_milo",
      handle: "milo",
      email: "milo@seed.osn.dev",
      displayName: "Milo Zhang",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_nina",
      handle: "nina",
      email: "nina@seed.osn.dev",
      displayName: "Nina Johansson",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },

    // ── Strangers (no connection to "me") ─────────────────────────────────
    {
      id: "usr_seed_omar",
      handle: "omar",
      email: "omar@seed.osn.dev",
      displayName: "Omar Farouk",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_priya",
      handle: "priya",
      email: "priya@seed.osn.dev",
      displayName: "Priya Sharma",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_quinn",
      handle: "quinn",
      email: "quinn@seed.osn.dev",
      displayName: "Quinn O'Brien",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_rosa",
      handle: "rosa",
      email: "rosa@seed.osn.dev",
      displayName: "Rosa Delgado",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_sam",
      handle: "sam",
      email: "sam@seed.osn.dev",
      displayName: "Sam Oduya",
      avatarUrl: null,
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
  ];
}

// ---------------------------------------------------------------------------
// Seed close friends
// ---------------------------------------------------------------------------

export function buildSeedCloseFriends(now: Date): NewCloseFriend[] {
  const ME = "usr_seed_me";
  return [
    { id: "clf_seed_1", userId: ME, friendId: "usr_seed_alice", createdAt: now },
    { id: "clf_seed_2", userId: ME, friendId: "usr_seed_charlie", createdAt: now },
    { id: "clf_seed_3", userId: ME, friendId: "usr_seed_dana", createdAt: now },
  ];
}

// ---------------------------------------------------------------------------
// Run seed
// ---------------------------------------------------------------------------

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

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

  // eslint-disable-next-line no-console -- CLI seed script output
  console.log(
    "Seed complete — 20 users, 25 connections, 3 close friends inserted (existing rows skipped).",
  );
}).pipe(Effect.provide(DbLive));

// eslint-disable-next-line no-console -- CLI seed script error handler
Effect.runPromise(seed).catch(console.error);
