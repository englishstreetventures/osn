import { weddingHosts, weddings } from "@cire/db";
import { and, asc, count, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { entitlementPresent } from "./entitlements";
import type { EntitlementKey } from "./entitlements";

/**
 * Every value the `wedding_hosts.role` column may hold, read off the column
 * itself. The app-layer vocabulary below derives from this, so the two cannot
 * drift: widening the column widens {@link HostRole}, and every exhaustive
 * switch over it stops compiling until the new role is handled.
 */
export type StoredHostRole = (typeof weddingHosts.$inferSelect)["role"];

/**
 * A co-host's role in the app layer. `editor` gets full module writes (guests,
 * schedule, invite, import — a partner or hired planner); `viewer` is
 * read-only across the dashboard; `helper` is the day-of run sheet and nothing
 * else. The owner is never rowed into `wedding_hosts`, so "owner" is not a
 * stored role.
 *
 * `host` is excluded: it is the legacy pre-roles value and still the column's
 * DDL DEFAULT (unchangeable without a table rebuild), but no reader treats it
 * as a role of its own — {@link normaliseHostRole} folds it into `editor`.
 */
export type HostRole = Exclude<StoredHostRole, "host">;

/**
 * Which stored values a route may WRITE onto a seat — one answer per value the
 * column is declared to hold. Exhaustive over {@link StoredHostRole}, so a
 * value added to the column has to be told whether it can be assigned before
 * this compiles, and the answer it cannot acquire by silence is "yes".
 *
 * `host` is `false` and stays that way: it is the column's DDL default and its
 * pre-roles value, not a role anyone holds, and {@link normaliseHostRole} folds
 * it away before any reader sees it.
 */
const ASSIGNABLE_HOST_ROLES = {
  host: false,
  editor: true,
  viewer: true,
  helper: true,
} as const satisfies Record<StoredHostRole, boolean>;

/**
 * The roles the organiser API may WRITE, derived from the map above rather than
 * written out beside it. `add()` and `setRole()` take this, so the compiler
 * proves no route can assign anything outside it — independently of the runtime
 * bar `HostRoleSchema` puts on the request body.
 */
export type AssignableHostRole = {
  [K in StoredHostRole]: (typeof ASSIGNABLE_HOST_ROLES)[K] extends true ? K : never;
}[StoredHostRole];

/**
 * Each role's privilege rank, lowest first. Exhaustive over {@link HostRole} by
 * type — a role added to the column must be ranked here before this compiles,
 * which is what makes {@link LEAST_PRIVILEGE_ROLE} true rather than merely
 * intended.
 */
const ROLE_PRIVILEGE_RANK = {
  helper: 0,
  viewer: 1,
  editor: 2,
} satisfies Record<HostRole, number>;

/**
 * What an unrecognised stored role degrades to: the narrowest role there is.
 * Derived from {@link ROLE_PRIVILEGE_RANK} rather than written out, so adding a
 * role below the current floor moves the floor with it instead of leaving a
 * stale literal that grants more than the newest role gets.
 */
export const LEAST_PRIVILEGE_ROLE: HostRole = (
  Object.keys(ROLE_PRIVILEGE_RANK) as HostRole[]
).reduce((lowest, role) =>
  ROLE_PRIVILEGE_RANK[role] < ROLE_PRIVILEGE_RANK[lowest] ? role : lowest,
);

/**
 * How far into the run sheet a seat may see, as stored on
 * `wedding_hosts.run_sheet_scope`. It is a helper's setting and no other role's
 * — `runSheetScopeFor()` in `../middleware/wedding-role` is what decides when it
 * applies.
 */
export type RunSheetScope = (typeof weddingHosts.$inferSelect)["runSheetScope"];

const RUN_SHEET_SCOPES = {
  own: true,
  full: true,
} satisfies Record<RunSheetScope, true>;

/** The narrowest scope — what an unrecognised stored value degrades to, so a
 *  corrupted row shows a helper less rather than more. */
export const LEAST_PRIVILEGE_RUN_SHEET_SCOPE: RunSheetScope = "own";

/** Map a stored scope onto {@link RunSheetScope}, degrading anything the column
 *  is not declared to hold to the narrow value. */
export function normaliseRunSheetScope(scope: string): RunSheetScope {
  if (!Object.hasOwn(RUN_SHEET_SCOPES, scope)) return LEAST_PRIVILEGE_RUN_SHEET_SCOPE;
  switch (scope as RunSheetScope) {
    case "own":
      return "own";
    case "full":
      return "full";
  }
  return LEAST_PRIVILEGE_RUN_SHEET_SCOPE;
}

/** Membership test for {@link StoredHostRole}, keyed rather than listed so a
 *  value added to the column has to be answered for here too. Exported so a
 *  test can enumerate the stored roles without restating them — a restated list
 *  is one that stops matching the column the first time it is widened. */
export const STORED_HOST_ROLES = {
  host: true,
  editor: true,
  viewer: true,
  helper: true,
} satisfies Record<StoredHostRole, true>;

function isStoredHostRole(role: string): role is StoredHostRole {
  return Object.hasOwn(STORED_HOST_ROLES, role);
}

/** Fold a recognised stored value onto the app-layer role it means. */
function mapStoredRole(role: StoredHostRole): HostRole {
  switch (role) {
    // Migration 0031 rewrote every legacy `host` row to `editor`; a stray one
    // is what every pre-roles co-host effectively was.
    case "host":
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
    case "helper":
      return "helper";
  }
  const _exhaustive: never = role;
  return LEAST_PRIVILEGE_ROLE;
}

/**
 * Map a stored role onto the app-layer {@link HostRole}. A value the column is
 * not declared to hold — corrupted, or written by something that bypassed the
 * schema — degrades to {@link LEAST_PRIVILEGE_ROLE} so the gate chain never
 * fails open.
 */
export function normaliseHostRole(role: string): HostRole {
  if (!isStoredHostRole(role)) return LEAST_PRIVILEGE_ROLE;
  return mapStoredRole(role);
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

type AuthorizeResult = {
  ownerOsnProfileId: string;
  isOwner: boolean;
  isHost: boolean;
  role: "owner" | HostRole | null;
  /** The caller's `wedding_hosts.id`, or `null` when they are the owner (never
   *  rowed in) or a stranger. The run-sheet gate needs it to tell the caller's
   *  own assignments from everyone else's. */
  hostId: string | null;
  /** The caller's stored run-sheet visibility. `own` for anyone with no seat —
   *  the narrow value, so a missing row can never widen what is returned. */
  runSheetScope: RunSheetScope;
};

/**
 * The entitlement-free `authorize()` — the query shape this service has always
 * run, extracted so both the plain caller and
 * {@link authorizeWithEntitlement}'s defect fallback can reach it.
 */
function authorizePlain(
  weddingId: string,
  osnProfileId: string,
): Effect.Effect<AuthorizeResult | null, never, DbService> {
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
        // The owner is never rowed into wedding_hosts, so there is no seat id
        // and no stored scope; they see the whole run sheet by role.
        hostId: null,
        runSheetScope: LEAST_PRIVILEGE_RUN_SHEET_SCOPE,
      };
    }

    const [host] = yield* dbQuery(() =>
      db
        .select({
          id: weddingHosts.id,
          role: weddingHosts.role,
          runSheetScope: weddingHosts.runSheetScope,
        })
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
      hostId: host?.id ?? null,
      runSheetScope: host
        ? normaliseRunSheetScope(host.runSheetScope)
        : LEAST_PRIVILEGE_RUN_SHEET_SCOPE,
    };
  }).pipe(Effect.withSpan("cire.host.authorize"));
}

/**
 * The `entitlementKey`-carrying half of `authorize()` — kept as a separate
 * function rather than an inline branch so the plain path above stays exactly
 * the query it always was, byte for byte, for every caller that never asks
 * for an entitlement fold. Each SELECT gains one boolean `entitled` column
 * (an `EXISTS` subquery against `wedding_entitlements`) instead of the caller
 * issuing a THIRD, separate `entitlementService.has()` round trip afterward —
 * same total query count as the plain path (one query on the owner branch,
 * two on the co-host branch), now carrying the entitlement answer too.
 */
function authorizeWithEntitlement(
  weddingId: string,
  osnProfileId: string,
  entitlementKey: EntitlementKey,
): Effect.Effect<(AuthorizeResult & { entitled?: boolean }) | null, never, DbService> {
  const entitledExists = entitlementPresent(weddingId, entitlementKey);

  return Effect.gen(function* () {
    const db = yield* DbService;
    const [owner] = yield* dbQuery(() =>
      db
        .select({ owner: weddings.ownerOsnProfileId, entitled: entitledExists })
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
        hostId: null,
        runSheetScope: LEAST_PRIVILEGE_RUN_SHEET_SCOPE,
        entitled: Boolean(owner.entitled),
      };
    }

    const [host] = yield* dbQuery(() =>
      db
        .select({
          id: weddingHosts.id,
          role: weddingHosts.role,
          runSheetScope: weddingHosts.runSheetScope,
          entitled: entitledExists,
        })
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
      hostId: host?.id ?? null,
      runSheetScope: host
        ? normaliseRunSheetScope(host.runSheetScope)
        : LEAST_PRIVILEGE_RUN_SHEET_SCOPE,
      // No host row means neither the owner nor a co-host branch matched — the
      // caller is a stranger, and `entitled` is meaningless (the role gate
      // 403s before anything reads it), so `false` rather than a bogus query.
      entitled: host ? Boolean(host.entitled) : false,
    };
  }).pipe(
    Effect.withSpan("cire.host.authorize"),
    // Folding the entitlement probe into the role query folds their failure
    // modes together too. A defect confined to `wedding_entitlements` — a bad
    // row, a lock, an index problem — must deny only the entitlement half (a
    // scoped 402, with a log line naming the wedding and the key) while the
    // role check still answers. Left alone, that defect would throw out of the
    // gate's derive and 500 every gated route, with a generic log nobody can
    // triage from.
    //
    // So fall back to the plain role query. It answers the role on its own
    // and returns no `entitled`, so no fold reaches the context and
    // `weddingEntitlement` runs its own `has()`, still wrapped in its own
    // defect-to-false-with-log: the two checks fail independently, each with
    // its own scoped outcome. If the role half is what defected,
    // `authorizePlain` defects too and the request 500s.
    Effect.catchDefect((defect) =>
      Effect.logWarning(
        "cire.host.authorize entitlement fold failed — falling back to the plain role query",
      ).pipe(
        Effect.annotateLogs({ weddingId, entitlement: entitlementKey }),
        Effect.andThen(Effect.logDebug(String(defect))),
        Effect.andThen(authorizePlain(weddingId, osnProfileId)),
      ),
    ),
  );
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
    role: AssignableHostRole;
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

      return {
        id,
        osnProfileId: input.osnProfileId,
        role: input.role,
        createdAt: now,
        addedByOsnProfileId: input.addedByOsnProfileId,
      };
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
    role: AssignableHostRole;
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
              .returning({
                id: weddingHosts.id,
                createdAt: weddingHosts.createdAt,
                addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
              })
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
        addedByOsnProfileId: updated.addedByOsnProfileId,
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
   *
   * `entitlementKey`, when given, folds a presence check for that entitlement
   * into the SAME query as the owner/host lookup (an `EXISTS` column, same
   * idiom as `directory.ts`'s `inWedding`) rather than a separate round trip —
   * see `weddingEntitlement`. Omitted, this runs exactly the query shape it
   * always has, so a role gate on a route with no entitlement gate — which
   * must never pass a key — is unaffected.
   */
  authorize(
    weddingId: string,
    osnProfileId: string,
    entitlementKey?: EntitlementKey,
  ): Effect.Effect<
    | (AuthorizeResult & {
        /** Only present when `entitlementKey` was passed. */
        entitled?: boolean;
      })
    | null,
    never,
    DbService
  > {
    if (entitlementKey) {
      return authorizeWithEntitlement(weddingId, osnProfileId, entitlementKey);
    }
    return authorizePlain(weddingId, osnProfileId);
  },
};
