import { weddingHosts, weddings } from "@cire/db";
import { and, asc, count, eq } from "drizzle-orm";
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
  /**
   * Who created this seat. Surfaced (not just stored) because `POST /hosts` is
   * open to editors: an owner looking at their co-host list needs to see which
   * seats they did not create themselves, since a seat grants the household
   * claim codes (`guests.csv`'s first column) and the Art. 9 dietary export.
   * Without it, an editor-added co-host is indistinguishable from an
   * owner-added one and the owner has nothing to react to.
   */
  addedByOsnProfileId: string;
}

/** The add would duplicate an existing seat, target the owner (who is already
 *  implicitly a host and can't be demoted into the join table), or push the
 *  wedding past {@link MAX_HOSTS_PER_WEDDING}. */
export class HostConflict extends Data.TaggedError("HostConflict")<{
  reason: "already_host" | "owner_is_host" | "host_cap_reached";
}> {}

/**
 * How many co-host seats one wedding may hold, and the reason there is a
 * number here at all.
 *
 * `POST /hosts` is `weddingEditor()`-gated, so an editor can create seats. The
 * design's whole safety argument is that this is safe BECAUSE it is additive:
 * only the owner can remove, so every seat an editor creates is reversible by
 * the one person who can't be removed. That argument depends on the owner being
 * able to SEE every seat — and {@link LIST_CEILING} truncates the list. A
 * security review drove it: 211 seats added, 200 listed, **11 live co-hosts the
 * owner could neither see nor name in a DELETE**. Reversibility silently ran out.
 *
 * So the cap sits well below the read ceiling, which turns "the list shows every
 * seat" from a coincidence into a structural invariant. 50 is far past any real
 * wedding (a couple, both sets of parents, a planner) and far short of 200.
 */
export const MAX_HOSTS_PER_WEDDING = 50;

/**
 * Row ceiling on the co-host list. Kept ABOVE {@link MAX_HOSTS_PER_WEDDING} on
 * purpose: it is the defensive bound (P-I1), not the policy, and the gap is
 * what guarantees a wedding at the cap is still listed whole. Legacy weddings
 * seeded past the cap before it existed still list up to this many.
 */
const LIST_CEILING = 200;

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
   * Add `osnProfileId` as a co-host of `weddingId` with the given role.
   *
   * The route has proven, via `weddingEditor()`, that the caller may add — the
   * OWNER or an `editor` co-host. So `addedByOsnProfileId` (the actor, kept for
   * attribution) and `ownerOsnProfileId` (the wedding's owner, read from the
   * wedding row) are DIFFERENT ids and must stay that way: conflating them
   * would make the owner-is-host check compare the owner against the editor,
   * miss, and row the owner in as a co-host of their own wedding — after which
   * a later "remove host" would appear to strip them.
   *
   * Three ways to be refused: the target is the owner (`owner_is_host`), the
   * target already holds a seat (`already_host`, from the unique index — never
   * a duplicate seat, and never a silent promotion of an existing `viewer`),
   * or the wedding is at {@link MAX_HOSTS_PER_WEDDING} (`host_cap_reached`).
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

      // Cap check before the insert. Deliberately count-then-insert rather than
      // a constraint: SQLite can't express "at most N rows per wedding_id", and
      // the alternative (insert then count then delete) leaves a live seat for
      // the width of the round trip. The race — two adds passing the count at
      // once — can overshoot by the number of concurrent writers, which is
      // bounded by the per-user rate limiter and lands far below the list
      // ceiling; the invariant that matters (every seat is listable, therefore
      // removable) survives an overshoot of a handful.
      const [seats] = yield* dbQuery(() =>
        db
          .select({ count: count() })
          .from(weddingHosts)
          .where(eq(weddingHosts.weddingId, input.weddingId))
          .all(),
      );
      if ((seats?.count ?? 0) >= MAX_HOSTS_PER_WEDDING) {
        yield* Effect.logWarning("host add refused: cap reached", {
          weddingId: input.weddingId,
          cap: MAX_HOSTS_PER_WEDDING,
        });
        return yield* Effect.fail(new HostConflict({ reason: "host_cap_reached" }));
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

  /**
   * All co-hosts of a wedding, oldest first, plus the true row count.
   *
   * `total` exists so truncation can never be silent. The list is bounded by
   * {@link LIST_CEILING}; `MAX_HOSTS_PER_WEDDING` keeps a compliant wedding
   * well under it, but a wedding seeded past the cap before it existed can
   * still exceed it, and a caller that cannot tell "50 seats" from "50 of 211
   * seats" will quietly show an owner an incomplete list of who can read their
   * guests' data.
   */
  list(
    weddingId: string,
  ): Effect.Effect<{ hosts: WeddingHostRow[]; total: number }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddingHosts.id,
            osnProfileId: weddingHosts.osnProfileId,
            role: weddingHosts.role,
            createdAt: weddingHosts.createdAt,
            addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
          })
          .from(weddingHosts)
          .where(eq(weddingHosts.weddingId, weddingId))
          .orderBy(asc(weddingHosts.createdAt))
          // Defensive ceiling (P-I1): a wedding has a handful of hosts; bounds
          // the worst-case payload if a row ever accumulates pathologically many.
          .limit(LIST_CEILING)
          .all(),
      );
      // Counted in the same parallel step rather than derived from `rows.length`,
      // which would report the ceiling as the truth exactly when it isn't.
      const [total] = yield* dbQuery(() =>
        db
          .select({ count: count() })
          .from(weddingHosts)
          .where(eq(weddingHosts.weddingId, weddingId))
          .all(),
      );
      return {
        hosts: rows.map((row) => ({ ...row, role: normaliseHostRole(row.role) })),
        total: total?.count ?? rows.length,
      };
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
