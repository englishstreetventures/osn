import { Effect, Data } from "effect";
import { DbLive, Db } from "./service";
import { users } from "./schema";
import type { NewUser } from "./schema";

class SeedError extends Data.TaggedError("SeedError")<{ cause: unknown }> {}

/**
 * Seed users for development and testing.
 *
 * Stable IDs:
 *   usr_seed_alice — Alice Chen
 *   usr_seed_bob   — Bob Martinez
 *   usr_seed_me    — placeholder for the authenticated dev user;
 *                    the Pulse frontend matches event.createdByUserId
 *                    against the real JWT sub at runtime
 */
export function buildSeedUsers(now: Date): NewUser[] {
  return [
    {
      id: "usr_seed_alice",
      email: "alice@seed.osn.dev",
      displayName: "Alice Chen",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_bob",
      email: "bob@seed.osn.dev",
      displayName: "Bob Martinez",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_seed_me",
      email: "me@seed.osn.dev",
      displayName: "You (seed)",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

  yield* Effect.tryPromise({
    try: () => db.insert(users).values(buildSeedUsers(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  console.log("Seed complete — 3 users inserted (existing seed rows skipped).");
}).pipe(Effect.provide(DbLive));

Effect.runPromise(seed).catch(console.error);
