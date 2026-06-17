import { weddingHosts, weddings } from "@cire/db";
import { and, asc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";

/** A co-host row surfaced to the management panel. Never echoes the account id —
 *  only the profile id (which the organiser typed a handle for) + when it was added. */
export interface WeddingHostRow {
  id: string;
  osnProfileId: string;
  role: "host";
  createdAt: Date;
}

/** The add would duplicate an existing seat, or target the owner (who is
 *  already implicitly a host and can't be demoted into the join table). */
export class HostConflict extends Data.TaggedError("HostConflict")<{
  reason: "already_host" | "owner_is_host";
}> {}

/** A host row could not be written/removed (driver error). */
export class HostWriteError extends Data.TaggedError("HostWriteError")<{
  op: "insert" | "delete";
  reason: string;
}> {}

/**
 * Maps a SQLite UNIQUE-constraint failure on the (wedding_id, osn_profile_id)
 * index to the `already_host` conflict. Exported so the brittle string match is
 * pinned by a direct unit test, independent of the driver's exact wording.
 */
export function hostConflictReason(message: string): HostConflict["reason"] | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  if (message.includes("wedding_hosts")) return "already_host";
  return null;
}

export const hostsService = {
  /**
   * Add `osnProfileId` as a co-host of `weddingId`. The caller (route) has
   * already proven, via `weddingOwner()`, that `addedByOsnProfileId` owns the
   * wedding and passes the wedding's `ownerOsnProfileId` so we can reject adding
   * the owner themselves (they're already implicitly a host — rowing them in
   * would let a later "remove host" appear to strip the owner). A repeat add is
   * caught from the unique index as `already_host`, never a duplicate seat.
   */
  add(input: {
    weddingId: string;
    osnProfileId: string;
    addedByOsnProfileId: string;
    ownerOsnProfileId: string;
  }): Effect.Effect<WeddingHostRow, HostConflict | HostWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      if (input.osnProfileId === input.ownerOsnProfileId) {
        return yield* Effect.fail(new HostConflict({ reason: "owner_is_host" }));
      }

      const id = `whost_${crypto.randomUUID()}`;
      const now = new Date();

      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(weddingHosts)
              .values({
                id,
                weddingId: input.weddingId,
                osnProfileId: input.osnProfileId,
                addedByOsnProfileId: input.addedByOsnProfileId,
                role: "host",
                createdAt: now,
              })
              .run(),
          ),
        catch: (e) => {
          const message = String(e);
          const reason = hostConflictReason(message);
          return reason
            ? new HostConflict({ reason })
            : new HostWriteError({ op: "insert", reason: message });
        },
      }).pipe(
        Effect.tapError((err) =>
          err._tag === "HostConflict"
            ? Effect.logWarning("host add conflict", { reason: err.reason })
            : Effect.logError("host insert failed", { reason: err.reason }),
        ),
      );

      return { id, osnProfileId: input.osnProfileId, role: "host" as const, createdAt: now };
    }).pipe(Effect.withSpan("cire.host.add"));
  },

  /** All co-hosts of a wedding, oldest first. */
  list(weddingId: string): Effect.Effect<WeddingHostRow[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddingHosts.id,
            osnProfileId: weddingHosts.osnProfileId,
            role: weddingHosts.role,
            createdAt: weddingHosts.createdAt,
          })
          .from(weddingHosts)
          .where(eq(weddingHosts.weddingId, weddingId))
          .orderBy(asc(weddingHosts.createdAt))
          // Defensive ceiling (P-I1): a wedding has a handful of hosts; bounds
          // the worst-case payload if a row ever accumulates pathologically many.
          .limit(200)
          .all(),
      );
      return rows;
    }).pipe(Effect.withSpan("cire.host.list"));
  },

  /**
   * Remove a co-host. Scoped to `(weddingId, osnProfileId)` so an owner can only
   * remove a host from their own wedding (the route's `weddingOwner()` proved
   * ownership). Idempotent: removing a host that isn't there succeeds.
   */
  remove(input: {
    weddingId: string;
    osnProfileId: string;
  }): Effect.Effect<void, HostWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(weddingHosts)
              .where(
                and(
                  eq(weddingHosts.weddingId, input.weddingId),
                  eq(weddingHosts.osnProfileId, input.osnProfileId),
                ),
              )
              .run(),
          ),
        catch: (e) => new HostWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("host delete failed", { reason: err.reason })),
      );
    }).pipe(Effect.withSpan("cire.host.remove"));
  },

  /**
   * Is `osnProfileId` allowed to reach `weddingId`'s dashboard? True when they
   * own it OR co-host it. Returns the owner id too so the caller (the
   * `weddingMember()` gate) can distinguish owner from co-host for the
   * owner-only management actions, in a single round-trip. `null` owner means
   * the wedding doesn't exist (caller maps to 404).
   */
  authorize(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<
    { ownerOsnProfileId: string; isOwner: boolean; isHost: boolean } | null,
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [owner] = yield* dbQuery(() =>
        db
          .select({ owner: weddings.ownerOsnProfileId })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      if (!owner) return null;

      const isOwner = owner.owner === osnProfileId;
      if (isOwner) {
        return { ownerOsnProfileId: owner.owner, isOwner: true, isHost: false };
      }

      const [host] = yield* dbQuery(() =>
        db
          .select({ id: weddingHosts.id })
          .from(weddingHosts)
          .where(
            and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId)),
          )
          .limit(1)
          .all(),
      );
      return { ownerOsnProfileId: owner.owner, isOwner: false, isHost: Boolean(host) };
    }).pipe(Effect.withSpan("cire.host.authorize"));
  },
};
