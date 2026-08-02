import {
  accounts,
  blocks,
  connections,
  organisationMembers,
  organisations,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { handlePrefixRange, likeContains, normaliseHandleQuery } from "@shared/db-utils/search";
import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RecommendationError extends Data.TaggedError("RecommendationError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Caller's connection list is capped before we expand to friends-of-friends.
 * Prevents a hub user with thousands of connections from producing an
 * unbounded FOF fan-out (P-C1). Tuned for the "enough candidates to produce
 * a good top-N list" sweet spot.
 */
const MAX_MY_CONNECTIONS_FOR_FOF = 500;

/**
 * Rows read from the caller's own edge list. Sits above
 * MAX_MY_CONNECTIONS_FOR_FOF because this single read serves two purposes —
 * seeding the FOF fan-out (which takes the first MAX_MY_CONNECTIONS_FOR_FOF
 * *accepted* edges) and building the exclusion set, which wants pending edges
 * too so a request already in flight suppresses the suggestion.
 */
const MAX_MY_EDGE_ROWS = 1_000;

/** Cap on how many of the caller's organisations seed the co-member fan-out. */
const MAX_MY_ORGANISATIONS = 50;

/**
 * Hard cap on the FOF fan-out row count. Worst-case defence alongside
 * MAX_MY_CONNECTIONS_FOR_FOF — a viral cluster with very dense connections
 * would still be bounded by this limit.
 */
const MAX_FOF_FANOUT_ROWS = 10_000;

/**
 * Cap on the co-member fan-out from the caller's organisations. Same shape of
 * defence as MAX_FOF_FANOUT_ROWS: membership of one very large organisation
 * must not turn a suggestion request into an unbounded read.
 */
const MAX_ORG_COMEMBER_ROWS = 2_000;

/**
 * Minimum query length for profile search. Below this we return an empty list
 * (never an error) so a single keystroke can't walk the handle namespace —
 * mirrors `MIN_SEARCH_PREFIX` on the internal co-host autocomplete endpoint.
 */
export const MIN_SEARCH_QUERY_LENGTH = 2;

/**
 * Minimum query length before the unanchored `%q%` pass is allowed to run. It
 * is a full table scan (no index can serve a leading wildcard), and a two-char
 * infix is simultaneously the cheapest query to abuse and the least selective —
 * so the scan is reserved for queries long enough to be a real "I typed part of
 * a surname" recovery. Prefix matching still works from
 * `MIN_SEARCH_QUERY_LENGTH`.
 */
const MIN_INFIX_QUERY_LENGTH = 3;

/**
 * How many rows to over-fetch relative to the caller's requested limit. Blocked
 * profiles and the caller's own row are filtered in application code (the block
 * set is unbounded, so binding it into the SQL `NOT IN` would risk SQLite's
 * 999-variable ceiling); over-fetching keeps a page full despite that filtering.
 */
const SEARCH_OVERFETCH_FACTOR = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a profile was suggested. Drives the explanatory line in the UI. */
export type SuggestionReason = "mutual_connections" | "shared_organisation";

export interface Suggestion {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  mutualCount: number;
  reason: SuggestionReason;
  /**
   * One organisation the caller and the candidate both belong to, when there
   * is one. Present alongside `reason: "mutual_connections"` too — the reason
   * names the *strongest* signal, this is extra context for the card.
   */
  sharedOrganisation: { handle: string; name: string } | null;
}

/**
 * Caller-relative connection state, in the same vocabulary the graph service's
 * `getConnectionStatus` uses. Lets the search UI render the right action
 * (Connect / Pending / Connected) without an extra request per result.
 */
export type SearchConnectionState = "none" | "pending_sent" | "pending_received" | "connected";

export interface ProfileSearchResult {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  connectionStatus: SearchConnectionState;
}

/** Internal row shape shared by the two search passes before ranking. */
interface ProfileRow {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OrganisationSearchResult {
  /**
   * The handle is the address, not the `org_*` id. `GET /organisations/:handle`
   * resolves by handle (`getOrganisationByHandle`), and the public
   * `orgProjection` deliberately omits the id — so returning the id here would
   * both widen that surface and hand the client a key nothing accepts.
   */
  handle: string;
  name: string;
  avatarUrl: string | null;
  /** Whether the caller is already a member — the row renders a badge, not a CTA. */
  isMember: boolean;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Ranks a two-field match: exact handle first, then handle prefix, then
 * name/display-name prefix, then handle infix, then name infix. Shared by
 * profile and organisation search so the two lists sort on the same rules.
 */
function matchRank(handle: string, name: string | null, query: string): number {
  const lowered = name?.toLowerCase() ?? "";
  if (handle === query) return 0;
  if (handle.startsWith(query)) return 1;
  if (lowered.startsWith(query)) return 2;
  if (handle.includes(query)) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Recommendation service factory
// ---------------------------------------------------------------------------

export function createRecommendationService() {
  /**
   * Suggest "people you may know" — profiles the caller is not connected to,
   * drawn from two signals the caller already has a relationship with:
   *
   * - **Mutual connections** (friends-of-friends): the stronger signal, ranked
   *   by how many of the caller's connections the candidate shares.
   * - **Shared organisations**: co-members of an organisation the caller
   *   belongs to. This is what gives a brand-new account something to act on —
   *   FOF alone returns nothing until the first connection is accepted.
   *
   * Algorithm:
   * 1. Read the caller's own edges (any status), blocks, and organisations.
   * 2. Build the exclusion set: self, anyone already connected *or* with a
   *    request in flight either way, and anyone blocked in either direction.
   * 3. Fan out to friends-of-friends (capped) and to organisation co-members
   *    (capped), tallying mutual counts and shared organisations per candidate.
   * 4. Rank by mutual count, then shared-organisation count, then handle.
   * 5. Hydrate the top N with profile data, skipping tombstoned accounts.
   */
  const suggestConnections = (
    profileId: string,
    limit = 10,
  ): Effect.Effect<Suggestion[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Defence-in-depth: the Elysia schema enforces [1, 50], but non-HTTP
      // callers might pass NaN / Infinity / negatives. Coerce any non-finite
      // input back to the default before clamping.
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 10, 1), 50);

      // Step 1: caller context. The three reads are independent — run them
      // concurrently (parallel on D1, sequential on bun:sqlite).
      const [myEdgeRows, blockRows, myOrgRows] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () =>
              db
                .select({
                  requesterId: connections.requesterId,
                  addresseeId: connections.addresseeId,
                  status: connections.status,
                })
                .from(connections)
                .where(
                  or(
                    eq(connections.requesterId, profileId),
                    eq(connections.addresseeId, profileId),
                  ),
                )
                .limit(MAX_MY_EDGE_ROWS),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
                .from(blocks)
                .where(or(eq(blocks.blockerId, profileId), eq(blocks.blockedId, profileId))),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .select({ organisationId: organisationMembers.organisationId })
                .from(organisationMembers)
                .where(eq(organisationMembers.profileId, profileId))
                .limit(MAX_MY_ORGANISATIONS),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      const counterpartOf = (row: { requesterId: string; addresseeId: string }) =>
        row.requesterId === profileId ? row.addresseeId : row.requesterId;

      // Accepted edges seed the FOF fan-out; *every* edge (pending included)
      // is an exclusion, so someone with a request already in flight is never
      // re-suggested — connecting to them would fail with "already exists".
      const myConnectionIds = myEdgeRows
        .filter((r) => r.status === "accepted")
        .map(counterpartOf)
        .slice(0, MAX_MY_CONNECTIONS_FOR_FOF);

      const blockedIds = blockRows.map((r) =>
        r.blockerId === profileId ? r.blockedId : r.blockerId,
      );
      const myOrgIds = myOrgRows.map((r) => r.organisationId);

      // Set for O(1) membership lookup in the aggregation loop (P-W2).
      const myConnectionIdSet = new Set(myConnectionIds);
      const excludeIds = new Set<string>([
        profileId,
        ...myEdgeRows.map(counterpartOf),
        ...blockedIds,
      ]);

      if (myConnectionIds.length === 0 && myOrgIds.length === 0) return [];

      // Step 2: fan out. Each branch is skipped when its seed set is empty, so
      // a caller with no connections pays for the organisation query only.
      const [fofRows, coMemberRows] = yield* Effect.all(
        [
          myConnectionIds.length === 0
            ? Effect.succeed([] as { requesterId: string; addresseeId: string }[])
            : Effect.tryPromise({
                try: () =>
                  db
                    .select({
                      requesterId: connections.requesterId,
                      addresseeId: connections.addresseeId,
                    })
                    .from(connections)
                    .where(
                      and(
                        eq(connections.status, "accepted"),
                        or(
                          inArray(connections.requesterId, myConnectionIds),
                          inArray(connections.addresseeId, myConnectionIds),
                        ),
                      ),
                    )
                    .limit(MAX_FOF_FANOUT_ROWS),
                catch: (cause) => new DatabaseError({ cause }),
              }),
          myOrgIds.length === 0
            ? Effect.succeed(
                [] as { profileId: string; organisationHandle: string; organisationName: string }[],
              )
            : Effect.tryPromise({
                try: () =>
                  db
                    .select({
                      profileId: organisationMembers.profileId,
                      organisationHandle: organisations.handle,
                      organisationName: organisations.name,
                    })
                    .from(organisationMembers)
                    .innerJoin(
                      organisations,
                      eq(organisations.id, organisationMembers.organisationId),
                    )
                    .where(inArray(organisationMembers.organisationId, myOrgIds))
                    .limit(MAX_ORG_COMEMBER_ROWS),
                catch: (cause) => new DatabaseError({ cause }),
              }),
        ],
        { concurrency: "unbounded" },
      );

      // Step 3: aggregate candidates.
      interface Candidate {
        mutualCount: number;
        organisationCount: number;
        sharedOrganisation: { handle: string; name: string } | null;
      }
      const candidates = new Map<string, Candidate>();
      const candidateFor = (id: string): Candidate => {
        const existing = candidates.get(id);
        if (existing) return existing;
        const fresh: Candidate = {
          mutualCount: 0,
          organisationCount: 0,
          sharedOrganisation: null,
        };
        candidates.set(id, fresh);
        return fresh;
      };

      for (const row of fofRows) {
        const isMutualRequester = myConnectionIdSet.has(row.requesterId);
        const isMutualAddressee = myConnectionIdSet.has(row.addresseeId);

        // Both sides are my connections — edge between two of my friends.
        if (isMutualRequester && isMutualAddressee) continue;

        const candidateId = isMutualRequester ? row.addresseeId : row.requesterId;

        if (excludeIds.has(candidateId)) continue;

        candidateFor(candidateId).mutualCount += 1;
      }

      for (const row of coMemberRows) {
        if (excludeIds.has(row.profileId)) continue;
        const candidate = candidateFor(row.profileId);
        candidate.organisationCount += 1;
        // First organisation wins as the label — one is all a card can show,
        // and `organisationCount` already carries the "how many" signal.
        candidate.sharedOrganisation ??= {
          handle: row.organisationHandle,
          name: row.organisationName,
        };
      }

      if (candidates.size === 0) return [];

      // Step 4: rank. Mutual connections outrank shared organisations; handle
      // breaks ties so the list is stable between requests.
      const sorted = [...candidates.entries()]
        .toSorted(
          ([idA, a], [idB, b]) =>
            b.mutualCount - a.mutualCount ||
            b.organisationCount - a.organisationCount ||
            (idA < idB ? -1 : idA > idB ? 1 : 0),
        )
        .slice(0, safeLimit);

      const candidateIds = sorted.map(([id]) => id);

      // Step 5: hydrate. The accounts join drops candidates whose account is
      // tombstoned (Art. 17 erasure pending) so a mid-deletion profile is
      // never suggested.
      const profiles = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: users.id,
              handle: users.handle,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(and(inArray(users.id, candidateIds), isNull(accounts.deletedAt))),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const profileMap = new Map(profiles.map((p) => [p.id, p]));

      return sorted
        .map(([id, candidate]) => {
          const p = profileMap.get(id);
          if (!p) return null;
          return {
            handle: p.handle,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
            mutualCount: candidate.mutualCount,
            reason:
              candidate.mutualCount > 0
                ? ("mutual_connections" as const)
                : ("shared_organisation" as const),
            sharedOrganisation: candidate.sharedOrganisation,
          };
        })
        .filter((s): s is Suggestion => s !== null);
    }).pipe(Effect.withSpan("recommendations.suggest_connections"));

  /**
   * Autocomplete-oriented people search over handle and display name.
   *
   * Two-phase by design. Pass 1 is an index **seek** over the handle range (see
   * `handlePrefixRange` — a plain `LIKE 'q%'` would silently full-scan) and
   * answers the common typeahead case. Pass 2 is an unanchored `%q%` match over
   * handle + display name; no index can serve a leading wildcard, so it is a
   * full scan and is gated twice: it runs only when pass 1 under-fills the page
   * *and* the query is at least `MIN_INFIX_QUERY_LENGTH` characters. Two-char
   * queries are both the cheapest to abuse and the least useful to scan for.
   *
   * Privacy: results carry nothing beyond the public profile fields plus the
   * caller's *own* connection state with each result — the same thing
   * `GET /graph/connections/:handle` already reports per handle, batched. No
   * mutual counts here: unlike suggestions (where the candidate is already
   * adjacent in the caller's graph), search takes an arbitrary handle, and
   * answering "how many mutuals" for arbitrary handles is a graph-inference
   * oracle (cf. `wiki/TODO.md` S-L4).
   */
  const searchProfiles = (
    profileId: string,
    rawQuery: string,
    limit = 8,
  ): Effect.Effect<ProfileSearchResult[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 8, 1), 20);

      const query = normaliseHandleQuery(rawQuery);
      // Below the minimum we return an empty list rather than an error — a
      // single keystroke shouldn't be a 4xx, and the empty result is what keeps
      // the enumeration surface small.
      if (query.length < MIN_SEARCH_QUERY_LENGTH) return [];

      const containsPattern = likeContains(query);
      const overfetch = safeLimit * SEARCH_OVERFETCH_FACTOR;

      const selectMatching = (where: ReturnType<typeof and>, rows: number) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({
                id: users.id,
                handle: users.handle,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
              })
              .from(users)
              .innerJoin(accounts, eq(users.accountId, accounts.id))
              .where(and(isNull(accounts.deletedAt), ne(users.id, profileId), where))
              .orderBy(asc(users.handle))
              .limit(rows),
          catch: (cause) => new DatabaseError({ cause }),
        });

      const range = handlePrefixRange(query);
      const matched = new Map<string, ProfileRow>();

      if (range) {
        for (const row of yield* selectMatching(
          and(gte(users.handle, range.lower), lt(users.handle, range.upper)),
          overfetch,
        )) {
          matched.set(row.id, row);
        }
      }

      // Pass 2 — the full scan. Gated on the page not being full AND on a query
      // long enough to be worth scanning for.
      if (matched.size < safeLimit && query.length >= MIN_INFIX_QUERY_LENGTH) {
        for (const row of yield* selectMatching(
          and(
            or(
              sql`${users.handle} LIKE ${containsPattern} ESCAPE '\\'`,
              sql`${users.displayName} LIKE ${containsPattern} ESCAPE '\\'`,
            ),
          ),
          overfetch,
        )) {
          matched.set(row.id, row);
        }
      }

      if (matched.size === 0) return [];

      // Blocks are probed against the candidate ids, not read wholesale for the
      // caller: an unbounded read to filter at most `overfetch × 2` rows scales
      // with how many people the caller has blocked rather than with anything
      // the request needs. Both `blocks_blocker_idx` and `blocks_blocked_idx`
      // serve this, and the bound parameter count peaks around 2 × overfetch.
      const candidateIds = [...matched.keys()];
      const blockRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
            .from(blocks)
            .where(
              or(
                and(eq(blocks.blockerId, profileId), inArray(blocks.blockedId, candidateIds)),
                and(eq(blocks.blockedId, profileId), inArray(blocks.blockerId, candidateIds)),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      for (const row of blockRows) {
        matched.delete(row.blockerId === profileId ? row.blockedId : row.blockerId);
      }

      const matches = matched;
      if (matches.size === 0) return [];

      const ranked = [...matches.values()]
        .toSorted(
          (a, b) =>
            matchRank(a.handle, a.displayName, query) - matchRank(b.handle, b.displayName, query) ||
            (a.handle < b.handle ? -1 : 1),
        )
        .slice(0, safeLimit);

      // Batch the caller's connection state across the page — one query for the
      // whole result set rather than one per row.
      const edgeRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              requesterId: connections.requesterId,
              addresseeId: connections.addresseeId,
              status: connections.status,
            })
            .from(connections)
            .where(
              or(
                and(
                  eq(connections.requesterId, profileId),
                  inArray(
                    connections.addresseeId,
                    ranked.map((r) => r.id),
                  ),
                ),
                and(
                  eq(connections.addresseeId, profileId),
                  inArray(
                    connections.requesterId,
                    ranked.map((r) => r.id),
                  ),
                ),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const stateById = new Map<string, SearchConnectionState>();
      for (const row of edgeRows) {
        const otherId = row.requesterId === profileId ? row.addresseeId : row.requesterId;
        stateById.set(
          otherId,
          row.status === "accepted"
            ? "connected"
            : row.requesterId === profileId
              ? "pending_sent"
              : "pending_received",
        );
      }

      return ranked.map((row) => ({
        handle: row.handle,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        connectionStatus: stateById.get(row.id) ?? "none",
      }));
    }).pipe(Effect.withSpan("recommendations.search_profiles"));

  /**
   * Autocomplete-oriented organisation search over handle and name. Same
   * two-phase shape and the same gating as `searchProfiles`: an index seek over
   * the handle range first, then the unanchored full-scan pass only when that
   * under-fills the page and the query is long enough to be worth scanning for.
   *
   * No exclusions beyond the query itself: organisations are public entities
   * with a handle in the same namespace as user handles, and the caller's own
   * organisations are *more* relevant in a search box, not less — they come
   * back flagged `isMember: true` so the row can say so.
   */
  const searchOrganisations = (
    profileId: string,
    rawQuery: string,
    limit = 5,
  ): Effect.Effect<OrganisationSearchResult[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 5, 1), 20);

      const query = normaliseHandleQuery(rawQuery);
      if (query.length < MIN_SEARCH_QUERY_LENGTH) return [];

      const containsPattern = likeContains(query);
      const overfetch = safeLimit * SEARCH_OVERFETCH_FACTOR;

      const selectMatching = (where: ReturnType<typeof and>, rows: number) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({
                id: organisations.id,
                handle: organisations.handle,
                name: organisations.name,
                avatarUrl: organisations.avatarUrl,
              })
              .from(organisations)
              .where(where)
              .orderBy(asc(organisations.handle))
              .limit(rows),
          catch: (cause) => new DatabaseError({ cause }),
        });

      const range = handlePrefixRange(query);
      const matches = new Map<
        string,
        { id: string; handle: string; name: string; avatarUrl: string | null }
      >();

      if (range) {
        for (const row of yield* selectMatching(
          and(gte(organisations.handle, range.lower), lt(organisations.handle, range.upper)),
          overfetch,
        )) {
          matches.set(row.id, row);
        }
      }

      if (matches.size < safeLimit && query.length >= MIN_INFIX_QUERY_LENGTH) {
        for (const row of yield* selectMatching(
          and(
            or(
              sql`${organisations.handle} LIKE ${containsPattern} ESCAPE '\\'`,
              sql`${organisations.name} LIKE ${containsPattern} ESCAPE '\\'`,
            ),
          ),
          overfetch,
        )) {
          matches.set(row.id, row);
        }
      }

      if (matches.size === 0) return [];

      const ranked = [...matches.values()]
        .toSorted(
          (a, b) =>
            matchRank(a.handle, a.name, query) - matchRank(b.handle, b.name, query) ||
            (a.handle < b.handle ? -1 : 1),
        )
        .slice(0, safeLimit);

      // One membership probe for the whole page rather than one per row.
      const membershipRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ organisationId: organisationMembers.organisationId })
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.profileId, profileId),
                inArray(
                  organisationMembers.organisationId,
                  ranked.map((r) => r.id),
                ),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const memberOf = new Set(membershipRows.map((r) => r.organisationId));

      return ranked.map((row) => ({
        handle: row.handle,
        name: row.name,
        avatarUrl: row.avatarUrl,
        isMember: memberOf.has(row.id),
      }));
    }).pipe(Effect.withSpan("recommendations.search_organisations"));

  return { suggestConnections, searchProfiles, searchOrganisations };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
