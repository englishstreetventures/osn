import { hostRsvpNotices, weddingHosts, weddings } from "@cire/db";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService, dbQuery } from "../db";
import { entitlementPresent } from "./entitlements";
import type { EntitlementKey } from "./entitlements";

/**
 * Every value the `wedding_hosts.role` column may hold, read off the column
 * itself. The app-layer vocabulary below derives from this, so the two cannot
 * drift: widening the column widens {@link WeddingRole}, and every exhaustive
 * switch over it stops compiling until the new role is handled.
 */
export type StoredHostRole = (typeof weddingHosts.$inferSelect)["role"];

/**
 * The role a seat gives its holder on a wedding — every organiser, owners
 * included, holds exactly one seat. `owner` manages the wedding itself (who
 * helps, claim codes, settings, billing, deletion) and every owner holds all of
 * it; `editor` gets full module writes (guests, schedule, invite, import — a
 * partner or hired planner); `viewer` is read-only across the dashboard;
 * `helper` is the day-of run sheet and nothing else.
 *
 * `host` is excluded: it is the legacy pre-roles value and still the column's
 * DDL DEFAULT (unchangeable without a table rebuild), but no reader treats it
 * as a role of its own — {@link normaliseHostRole} folds it into `editor`.
 */
export type WeddingRole = Exclude<StoredHostRole, "host">;

/** A seat below owner: the roles a co-host holds. */
export type HostRole = Exclude<WeddingRole, "owner">;

/**
 * Which stored values a route may WRITE onto a seat — one answer per value the
 * column is declared to hold. Exhaustive over {@link StoredHostRole}, so a
 * value added to the column has to be told whether it can be assigned before
 * this compiles, and the answer it cannot acquire by silence is "yes".
 *
 * `host` is `false` and stays that way: it is the column's DDL default and its
 * pre-roles value, not a role anyone holds, and {@link normaliseHostRole} folds
 * it away before any reader sees it. Which of the assignable roles a given
 * caller may grant is `assignableRolesFor()` in `../middleware/wedding-role`.
 */
const ASSIGNABLE_HOST_ROLES = {
  host: false,
  owner: true,
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
 * Each role's privilege rank, lowest first. Exhaustive over {@link WeddingRole}
 * by type — a role added to the column must be ranked here before this
 * compiles, which is what makes {@link LEAST_PRIVILEGE_ROLE} true rather than
 * merely intended.
 */
const ROLE_PRIVILEGE_RANK = {
  helper: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
} satisfies Record<WeddingRole, number>;

/**
 * What an unrecognised stored role degrades to: the narrowest role there is.
 * Derived from {@link ROLE_PRIVILEGE_RANK} rather than written out, so adding a
 * role below the current floor moves the floor with it instead of leaving a
 * stale literal that grants more than the newest role gets.
 */
export const LEAST_PRIVILEGE_ROLE: WeddingRole = (
  Object.keys(ROLE_PRIVILEGE_RANK) as WeddingRole[]
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
  owner: true,
  editor: true,
  viewer: true,
  helper: true,
} satisfies Record<StoredHostRole, true>;

function isStoredHostRole(role: string): role is StoredHostRole {
  return Object.hasOwn(STORED_HOST_ROLES, role);
}

/** Fold a recognised stored value onto the app-layer role it means. */
function mapStoredRole(role: StoredHostRole): WeddingRole {
  switch (role) {
    case "owner":
      return "owner";
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
 * Map a stored role onto the app-layer {@link WeddingRole}. A value the column
 * is not declared to hold — corrupted, or written by something that bypassed
 * the schema — degrades to {@link LEAST_PRIVILEGE_ROLE} so the gate chain never
 * fails open.
 */
export function normaliseHostRole(role: string): WeddingRole {
  if (!isStoredHostRole(role)) return LEAST_PRIVILEGE_ROLE;
  return mapStoredRole(role);
}

/** A seat surfaced to the management panel — owners and co-hosts alike. Never
 *  echoes the account id — only the profile id (which the organiser typed a
 *  handle for) + when it was added. */
export interface WeddingHostRow {
  id: string;
  osnProfileId: string;
  role: WeddingRole;
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

/** A seat could not be added or given a role: the target already holds a seat
 *  on this wedding (owners included), or the wedding is at
 *  {@link MAX_HOSTS_PER_WEDDING} co-hosts or {@link MAX_OWNERS_PER_WEDDING}
 *  owners. */
export class HostConflict extends Data.TaggedError("HostConflict")<{
  reason: "already_host" | "host_cap_reached" | "owner_cap_reached";
}> {}

/** A removal or role change would leave the wedding with no owner. Every
 *  wedding keeps at least one; the refused write changed nothing. */
export class LastOwner extends Data.TaggedError("LastOwner")<{
  weddingId: string;
}> {}

/**
 * How many co-host seats — every seat below owner — one wedding may hold, and
 * the reason there is a number here at all.
 *
 * `POST /hosts` is `weddingEditor()`-gated, so an editor can create seats. The
 * design's whole safety argument is that this is safe BECAUSE it is additive:
 * only an owner can remove, so every seat an editor creates is reversible by an
 * owner. That argument depends on the owners being able to SEE every seat — and
 * {@link LIST_CEILING} truncates the list. A security review drove it: 211
 * seats added, 200 listed, **11 live co-hosts the owner could neither see nor
 * name in a DELETE**. Reversibility silently ran out.
 *
 * So the cap sits well below the read ceiling, which turns "the list shows every
 * seat" from a coincidence into a structural invariant. 50 is far past any real
 * wedding (both sets of parents, siblings, a planner) and far short of 200.
 * Owners are not counted here; they have their own ceiling,
 * {@link MAX_OWNERS_PER_WEDDING}, and the two together stay under the list
 * ceiling.
 */
export const MAX_HOSTS_PER_WEDDING = 50;

/**
 * How many owners one wedding may hold. A wedding is owned by a couple, and
 * every owner holds every owner power — removing the others included — so the
 * ceiling is small: room for both partners and a parent or two, not a
 * committee. Owners are counted apart from co-hosts, so adding one never uses
 * up a co-host seat.
 */
export const MAX_OWNERS_PER_WEDDING = 4;

/**
 * Row ceiling on the seat list. Kept ABOVE {@link MAX_HOSTS_PER_WEDDING} +
 * {@link MAX_OWNERS_PER_WEDDING} on purpose: it is the defensive bound (P-I1),
 * not the policy, and the gap is what guarantees a wedding at both caps is still
 * listed whole. Legacy weddings seeded past the cap before it existed still
 * list up to this many.
 */
const LIST_CEILING = 200;

/** A host row could not be written/removed (driver error). */
export class HostWriteError extends Data.TaggedError("HostWriteError")<{
  op: "insert" | "update" | "delete";
  reason: string;
}> {}

/** A role change targeted a profile that holds no seat on the wedding. */
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

/** `weddingId`'s owner seats, counted inside whatever statement embeds it. */
function ownerSeatCount(weddingId: string): SQL<number> {
  return sql<number>`(SELECT count(*) FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} = 'owner')`;
}

/**
 * `weddingId`'s seats below owner, counted inside whatever statement embeds it.
 * This is what {@link MAX_HOSTS_PER_WEDDING} bounds, and the count any limit on
 * the people helping with a wedding reads: owners do not count towards it.
 */
export function nonOwnerSeatCount(weddingId: string): SQL<number> {
  return sql<number>`(SELECT count(*) FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} <> 'owner')`;
}

/** The (wedding, profile) pair that names one seat. */
const seatOf = (weddingId: string, osnProfileId: string) =>
  and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId));

type AuthorizeResult = {
  isOwner: boolean;
  /** True for a seat below owner. */
  isHost: boolean;
  role: WeddingRole | null;
  /** The caller's `wedding_hosts.id`, or `null` for a stranger. Every member,
   *  owners included, holds one; the run-sheet gate needs it to tell the
   *  caller's own assignments from everyone else's. */
  hostId: string | null;
  /** The caller's stored run-sheet visibility. `own` for anyone with no seat —
   *  the narrow value, so a missing row can never widen what is returned. */
  runSheetScope: RunSheetScope;
  /** The wedding's slug, read in the same query as the caller's seat, so a
   *  route that names a download after the wedding does not read the row again. */
  weddingSlug: string;
};

/** What the wedding row and the caller's seat on it — if any — say. */
function resolveSeat(row: {
  slug: string;
  seatId: string | null;
  role: string | null;
  runSheetScope: string | null;
}): AuthorizeResult {
  const role = row.role === null ? null : normaliseHostRole(row.role);
  return {
    isOwner: role === "owner",
    isHost: role !== null && role !== "owner",
    role,
    hostId: row.seatId,
    runSheetScope:
      row.runSheetScope === null
        ? LEAST_PRIVILEGE_RUN_SHEET_SCOPE
        : normaliseRunSheetScope(row.runSheetScope),
    weddingSlug: row.slug,
  };
}

/** The caller's seat joins the wedding row on (wedding, caller), so the one
 *  query answers both "does the wedding exist" and "what is the caller on it". */
const callerSeat = (osnProfileId: string) =>
  and(eq(weddingHosts.weddingId, weddings.id), eq(weddingHosts.osnProfileId, osnProfileId));

/**
 * The entitlement-free `authorize()`: the wedding row and the caller's seat on
 * it, in one query, with no `wedding_entitlements` column. Kept apart so both
 * the plain caller and {@link authorizeWithEntitlement}'s defect fallback can
 * reach it.
 */
function authorizePlain(
  weddingId: string,
  osnProfileId: string,
): Effect.Effect<AuthorizeResult | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({
          slug: weddings.slug,
          seatId: weddingHosts.id,
          role: weddingHosts.role,
          runSheetScope: weddingHosts.runSheetScope,
        })
        .from(weddings)
        .leftJoin(weddingHosts, callerSeat(osnProfileId))
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    return row ? resolveSeat(row) : null;
  }).pipe(Effect.withSpan("cire.host.authorize"));
}

/**
 * The `entitlementKey`-carrying half of `authorize()` — kept as a separate
 * function rather than an inline branch so the plain path above carries no
 * entitlement column for any caller that never asks for an entitlement fold.
 * The SELECT gains one boolean `entitled` column (an `EXISTS` subquery against
 * `wedding_entitlements`) instead of the caller issuing a second, separate
 * `entitlementService.has()` round trip afterward — the same single query as
 * the plain path, now carrying the entitlement answer too.
 */
function authorizeWithEntitlement(
  weddingId: string,
  osnProfileId: string,
  entitlementKey: EntitlementKey,
): Effect.Effect<(AuthorizeResult & { entitled?: boolean }) | null, never, DbService> {
  const entitledExists = entitlementPresent(weddingId, entitlementKey);

  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({
          slug: weddings.slug,
          seatId: weddingHosts.id,
          role: weddingHosts.role,
          runSheetScope: weddingHosts.runSheetScope,
          entitled: entitledExists,
        })
        .from(weddings)
        .leftJoin(weddingHosts, callerSeat(osnProfileId))
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    if (!row) return null;
    const resolved = resolveSeat(row);
    return {
      ...resolved,
      // No seat means the caller is a stranger, and `entitled` is meaningless
      // (the role gate 403s before anything reads it), so `false`.
      entitled: resolved.role !== null && Boolean(row.entitled),
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

/** A refused host change, logged once with the reason and the wedding. */
const logRefusal = (message: string, weddingId: string, reason: string) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ weddingId, reason }));

export const hostsService = {
  /**
   * Seat `osnProfileId` on `weddingId` with the given role.
   *
   * The route has proven, via `weddingEditor()`, that the caller may add — an
   * owner or an `editor` co-host — and, via `assignableRolesFor()`, that the
   * caller may grant `role`. `addedByOsnProfileId` is the caller, kept for
   * attribution.
   *
   * ONE statement, so both ceilings hold under concurrent adds: the INSERT's
   * own WHERE counts the seats it competes with — owners against
   * {@link MAX_OWNERS_PER_WEDDING} when adding an owner, every other seat
   * against {@link MAX_HOSTS_PER_WEDDING} otherwise — and a wedding already at
   * its ceiling inserts nothing, which RETURNING reports as no row. A
   * count-then-insert would let two adds at the same moment both pass.
   *
   * Three ways to be refused: the target already holds a seat, owners included
   * (`already_host`, from the unique index — never a duplicate seat, and never
   * a silent change of an existing seat's role), or the wedding is at the
   * ceiling the new seat counts against (`owner_cap_reached` /
   * `host_cap_reached`).
   */
  add(input: {
    weddingId: string;
    osnProfileId: string;
    addedByOsnProfileId: string;
    role: AssignableHostRole;
  }): Effect.Effect<WeddingHostRow, HostConflict | HostWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const id = `whost_${crypto.randomUUID()}`;
      const now = new Date();
      const addingOwner = input.role === "owner";
      const room = addingOwner
        ? sql`${ownerSeatCount(input.weddingId)} < ${MAX_OWNERS_PER_WEDDING}`
        : sql`${nonOwnerSeatCount(input.weddingId)} < ${MAX_HOSTS_PER_WEDDING}`;

      // The SELECT lists its values in the table's column order, which is the
      // column list drizzle writes for an INSERT … SELECT. Built off the
      // columns themselves, so a column added later without a value here
      // throws rather than shifting every value one place along.
      const values = {
        id: sql`${id}`,
        weddingId: sql`${input.weddingId}`,
        osnProfileId: sql`${input.osnProfileId}`,
        addedByOsnProfileId: sql`${input.addedByOsnProfileId}`,
        role: sql`${input.role}`,
        runSheetScope: sql`${LEAST_PRIVILEGE_RUN_SHEET_SCOPE}`,
        createdAt: sql`${weddingHosts.createdAt.mapToDriverValue(now)}`,
      } satisfies Record<keyof typeof weddingHosts.$inferSelect, SQL>;
      const selectList = Object.keys(getTableColumns(weddingHosts)).map((key) => {
        if (!Object.hasOwn(values, key)) {
          throw new Error(`wedding_hosts column "${key}" has no value`);
        }
        return values[key as keyof typeof values];
      });

      const inserted = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(weddingHosts)
              .select(sql`SELECT ${sql.join(selectList, sql`, `)} WHERE ${room}`)
              .returning({ id: weddingHosts.id })
              .all(),
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
            ? logRefusal("host add refused", input.weddingId, err.reason)
            : Effect.logError("host insert failed", { reason: err.reason }),
        ),
      );

      if (inserted.length === 0) {
        const reason = addingOwner ? "owner_cap_reached" : "host_cap_reached";
        yield* logRefusal("host add refused", input.weddingId, reason);
        return yield* Effect.fail(new HostConflict({ reason }));
      }

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
   * Every seat on a wedding — owners and co-hosts — oldest first, plus the true
   * row count.
   *
   * `total` exists so truncation can never be silent. The list is bounded by
   * {@link LIST_CEILING}; the two seat ceilings keep a compliant wedding well
   * under it, but a wedding seeded past the cap before it existed can still
   * exceed it, and a caller that cannot tell "50 seats" from "50 of 211 seats"
   * will quietly show an owner an incomplete list of who can read their
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
   * Change a seat's role, owners' included. Scoped to `(weddingId,
   * osnProfileId)` — the route's `weddingOwner()` proved the caller owns this
   * wedding, so this can't retarget another wedding's seat. Setting the role a
   * seat already has succeeds (idempotent).
   *
   * The guards ride in the UPDATE's own WHERE, so they hold however many owners
   * act at once: promoting to owner needs room under
   * {@link MAX_OWNERS_PER_WEDDING}; moving an owner down needs another owner to
   * remain AND room under {@link MAX_HOSTS_PER_WEDDING} for the seat it becomes.
   * A refused change writes nothing. A read of the seat and the two counts
   * rides in the same batch, so the reason given is the one the UPDATE saw.
   *
   * Fails `HostNotFound` when the profile holds no seat, `LastOwner` when the
   * seat is the wedding's only owner, and `HostConflict` when a ceiling is full.
   */
  setRole(input: {
    weddingId: string;
    osnProfileId: string;
    role: AssignableHostRole;
  }): Effect.Effect<
    WeddingHostRow,
    HostNotFound | LastOwner | HostConflict | HostWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const promotingToOwner = input.role === "owner";
      const allowed = promotingToOwner
        ? or(
            eq(weddingHosts.role, "owner"),
            sql`${ownerSeatCount(input.weddingId)} < ${MAX_OWNERS_PER_WEDDING}`,
          )
        : or(
            ne(weddingHosts.role, "owner"),
            and(
              sql`${ownerSeatCount(input.weddingId)} > 1`,
              sql`${nonOwnerSeatCount(input.weddingId)} < ${MAX_HOSTS_PER_WEDDING}`,
            ),
          );

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db
              .update(weddingHosts)
              .set({ role: input.role })
              .where(and(seatOf(input.weddingId, input.osnProfileId), allowed))
              .returning({
                id: weddingHosts.id,
                createdAt: weddingHosts.createdAt,
                addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
              }),
            db
              .select({
                owners: ownerSeatCount(input.weddingId),
              })
              .from(weddingHosts)
              .where(seatOf(input.weddingId, input.osnProfileId)),
          ]),
        catch: (e) => new HostWriteError({ op: "update", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("host role update failed", { reason: err.reason }),
        ),
      );
      const [updated] = results[0] as readonly {
        id: string;
        createdAt: Date;
        addedByOsnProfileId: string;
      }[];
      const [seat] = results[1] as readonly { owners: number }[];

      if (!updated) {
        if (!seat) return yield* Effect.fail(new HostNotFound({ weddingId: input.weddingId }));
        if (promotingToOwner) {
          yield* logRefusal("host role change refused", input.weddingId, "owner_cap_reached");
          return yield* Effect.fail(new HostConflict({ reason: "owner_cap_reached" }));
        }
        if (seat.owners <= 1) {
          yield* logRefusal("host change refused: last owner", input.weddingId, "last_owner");
          return yield* Effect.fail(new LastOwner({ weddingId: input.weddingId }));
        }
        yield* logRefusal("host role change refused", input.weddingId, "host_cap_reached");
        return yield* Effect.fail(new HostConflict({ reason: "host_cap_reached" }));
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
   * Remove a seat — a co-host's, another owner's, or the caller's own. Scoped to
   * `(weddingId, osnProfileId)` so an owner can only remove a seat from their
   * own wedding (the route's `weddingOwner()` proved ownership). Idempotent:
   * removing a profile that holds no seat succeeds.
   *
   * The wedding's last owner is never removed: the seat's DELETE carries the
   * guard in its own WHERE, so two owners removing each other at once leave
   * one of them. Their RSVP read marker and digest setting (`host_rsvp_notices`)
   * go in the same batch, AFTER the seat and only once it is gone — a refused
   * removal keeps both. A read of the seat closes the batch: still there means
   * the guard refused it, which fails `LastOwner`.
   */
  remove(input: {
    weddingId: string;
    osnProfileId: string;
  }): Effect.Effect<void, LastOwner | HostWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db
              .delete(weddingHosts)
              .where(
                and(
                  seatOf(input.weddingId, input.osnProfileId),
                  or(ne(weddingHosts.role, "owner"), sql`${ownerSeatCount(input.weddingId)} > 1`),
                ),
              ),
            db.delete(hostRsvpNotices).where(
              and(
                eq(hostRsvpNotices.weddingId, input.weddingId),
                eq(hostRsvpNotices.osnProfileId, input.osnProfileId),
                notExists(
                  db
                    .select({ one: sql`1` })
                    .from(weddingHosts)
                    .where(seatOf(input.weddingId, input.osnProfileId)),
                ),
              ),
            ),
            db
              .select({ id: weddingHosts.id })
              .from(weddingHosts)
              .where(seatOf(input.weddingId, input.osnProfileId)),
          ]),
        catch: (e) => new HostWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("host delete failed", { reason: err.reason })),
      );
      const remaining = results[2] as readonly { id: string }[];
      if (remaining.length > 0) {
        yield* logRefusal("host change refused: last owner", input.weddingId, "last_owner");
        return yield* Effect.fail(new LastOwner({ weddingId: input.weddingId }));
      }
    }).pipe(Effect.withSpan("cire.host.remove"));
  },

  /**
   * Is `osnProfileId` allowed to reach `weddingId`, and at what level? The
   * answer is their seat's role — every organiser, owners included, holds
   * exactly one seat — plus the wedding's slug, in ONE query: the wedding row
   * LEFT JOINed to the caller's seat. `null` means the wedding doesn't exist
   * (caller maps to 404); `role` is `null` when the caller holds no seat.
   *
   * `entitlementKey`, when given, folds a presence check for that entitlement
   * into the same query (an `EXISTS` column, same idiom as `directory.ts`'s
   * `inWedding`) rather than a separate round trip — see `weddingEntitlement`.
   * Omitted, no entitlement column is read, so a role gate on a route with no
   * entitlement gate — which must never pass a key — pays nothing for it.
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
