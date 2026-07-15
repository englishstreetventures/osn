import { weddingHosts, weddings } from "@cire/db";
import { and, asc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";

/**
 * A co-host's role. `editor` gets full module writes (guests, schedule,
 * invite, import — a partner or hired planner); `viewer` is read-only. The
 * owner is never rowed into `wedding_hosts`, so "owner" is not a stored role.
 */
export type HostRole = "editor" | "viewer";

/**
 * Map a stored role onto the app-layer {@link HostRole}. `host` is the legacy
 * pre-roles value (and still the column's DDL DEFAULT — unchangeable without a
 * table rebuild): migration 0031 rewrote all rows to `editor`, but a stray
 * legacy value degrades to `editor` (what every pre-roles co-host effectively
 * was). Anything ELSE — an unknown or corrupted value no code path writes —
 * degrades to `viewer`, the least-privilege role, so the gate chain never
 * fails open (S-L1).
 */
export function normaliseHostRole(role: string): HostRole {
  if (role === "editor" || role === "host") return "editor";
  return "viewer";
}

/** A co-host row surfaced to the management panel. Never echoes the account id —
 *  only the profile id (which the organiser typed a handle for) + when it was added. */
export interface WeddingHostRow {
  id: string;
  osnProfileId: string;
  role: HostRole;
  createdAt: Date;
}

/** The add would duplicate an existing seat, or target the owner (who is
 *  already implicitly a host and can't be demoted into the join table). */
export class HostConflict extends Data.TaggedError("HostConflict")<{
  reason: "already_host" | "owner_is_host";
}> {}

/** A host row could not be written/removed (driver error). */
export class HostWriteError extends Data.TaggedError("HostWriteError")<{
  op: "insert" | "update" | "delete";
  reason: string;
}> {}

/** A role change targeted a profile that isn't a co-host of the wedding. */
export class HostNotFound extends Data.TaggedError("HostNotFound")<{
  weddingId: string;
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
   * Add `osnProfileId` as a co-host of `weddingId` with the given role. The
   * caller (route) has already proven, via `weddingOwner()`, that
   * `addedByOsnProfileId` owns the wedding and passes the wedding's
   * `ownerOsnProfileId` so we can reject adding the owner themselves (they're
   * already implicitly a host — rowing them in would let a later "remove host"
   * appear to strip the owner). A repeat add is caught from the unique index as
   * `already_host`, never a duplicate seat.
   */
  add(input: {
    weddingId: string;
    osnProfileId: string;
    addedByOsnProfileId: string;
    ownerOsnProfileId: string;
    role: HostRole;
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
                role: input.role,
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

      return { id, osnProfileId: input.osnProfileId, role: input.role, createdAt: now };
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
      return rows.map((row) => ({ ...row, role: normaliseHostRole(row.role) }));
    }).pipe(Effect.withSpan("cire.host.list"));
  },

  /**
   * Change a co-host's role. Scoped to `(weddingId, osnProfileId)` — the
   * route's `weddingOwner()` proved ownership, so this can't retarget another
   * wedding's seat. Fails `HostNotFound` when the profile isn't a co-host
   * (which also covers the owner: they're never rowed in). Setting the role a
   * host already has succeeds (idempotent).
   */
  setRole(input: {
    weddingId: string;
    osnProfileId: string;
    role: HostRole;
  }): Effect.Effect<WeddingHostRow, HostNotFound | HostWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Single round trip (P-I1): the UPDATE is scoped to the (wedding, profile)
      // pair and RETURNING reports whether a seat existed — zero rows maps to
      // HostNotFound with no separate existence SELECT (D1 bills per query).
      const [updated] = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(weddingHosts)
              .set({ role: input.role })
              .where(
                and(
                  eq(weddingHosts.weddingId, input.weddingId),
                  eq(weddingHosts.osnProfileId, input.osnProfileId),
                ),
              )
              .returning({ id: weddingHosts.id, createdAt: weddingHosts.createdAt })
              .all(),
          ),
        catch: (e) => new HostWriteError({ op: "update", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("host role update failed", { reason: err.reason }),
        ),
      );
      if (!updated) {
        return yield* Effect.fail(new HostNotFound({ weddingId: input.weddingId }));
      }

      return {
        id: updated.id,
        osnProfileId: input.osnProfileId,
        role: input.role,
        createdAt: updated.createdAt,
      };
    }).pipe(Effect.withSpan("cire.host.setRole"));
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
   * Is `osnProfileId` allowed to reach `weddingId`'s dashboard, and at what
   * level? True when they own it OR co-host it. Returns the owner id too so the
   * caller (the `weddingMember()` / `weddingEditor()` gates) can distinguish
   * owner from co-host — and, via `role`, editor from viewer — in a single
   * round-trip. `null` result means the wedding doesn't exist (caller maps to
   * 404); `role` is `null` when the caller is neither owner nor host.
   */
  authorize(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<
    {
      ownerOsnProfileId: string;
      isOwner: boolean;
      isHost: boolean;
      role: "owner" | HostRole | null;
    } | null,
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
        return {
          ownerOsnProfileId: owner.owner,
          isOwner: true,
          isHost: false,
          role: "owner" as const,
        };
      }

      const [host] = yield* dbQuery(() =>
        db
          .select({ id: weddingHosts.id, role: weddingHosts.role })
          .from(weddingHosts)
          .where(
            and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId)),
          )
          .limit(1)
          .all(),
      );
      return {
        ownerOsnProfileId: owner.owner,
        isOwner: false,
        isHost: Boolean(host),
        role: host ? normaliseHostRole(host.role) : null,
      };
    }).pipe(Effect.withSpan("cire.host.authorize"));
  },
};
