import {
  accounts,
  blocks,
  connections,
  organisationMembers,
  organisations,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  handlePrefixRange,
  hasScanworthyToken,
  joinTokens,
  likeContains,
  normaliseHandleQuery,
  tokenContentLength,
  tokeniseQuery,
  tokensPrefixName,
} from "@shared/db-utils/search";
import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
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
 * Minimum query length for search, full stop. One character is enough because
 * the only pass that runs at that length is the one scoped to the caller's own
 * edges (see `MIN_GLOBAL_QUERY_LENGTH`) — a set the caller can already
 * enumerate via `GET /graph/connections`, so no length gate on it buys any
 * enumeration resistance. Below this we return an empty list, never an error.
 */
export const MIN_SEARCH_QUERY_LENGTH = 1;

/**
 * Minimum length of the **handle prefix being sought** before the pass that
 * reads beyond the caller's own edges may run, so a single keystroke can't walk
 * the handle namespace — mirrors `MIN_SEARCH_PREFIX` on the internal co-host
 * autocomplete endpoint.
 *
 * Measured against `handleQuery`, the string actually bound into the range, and
 * never against the raw phrase. The two differ whenever the query contains a
 * separator, and measuring the phrase is a bypass: `"a."` is two characters of
 * phrase carrying a one-character prefix, so a phrase-length gate would open a
 * one-character seek over every handle beginning `a`.
 */
const MIN_GLOBAL_QUERY_LENGTH = 2;

/**
 * Minimum length of the **longest token** before the unanchored `%token%` pass
 * may run. It is a full table scan (no index can serve a leading wildcard), and
 * a two-char infix is simultaneously the cheapest query to abuse and the least
 * selective — so the scan is reserved for queries carrying a term long enough
 * to be a real "I typed part of a surname" recovery. Prefix matching still
 * works from `MIN_GLOBAL_QUERY_LENGTH`.
 *
 * Applied per token by `hasScanworthyToken`, not to the query as a whole: the
 * patterns are ANDed, and a conjunction is only as selective as its most
 * selective conjunct. `"a b c"` totals three characters but is three
 * near-matchless scans; `"j smith"` totals six and carries one genuine term.
 * The first must not run, the second must. That helper also lowers the bar to
 * two characters for dense scripts, so a Latin-shaped threshold does not make
 * `"日本 太郎"` — every token of which is two characters — unsearchable.
 */
const MIN_INFIX_QUERY_LENGTH = 3;

/**
 * Cap on how many tokens a query contributes to the SQL it builds.
 *
 * Each token becomes its own ANDed pair of `LIKE` predicates, so the per-row
 * cost of the full-scan pass is linear in the token count. `q` is bounded at 64
 * characters at the HTTP boundary, which admits 32 single-character tokens —
 * and because such a conjunction matches nothing, `LIMIT` never short-circuits
 * the scan, so the whole table is walked with 64 pattern evaluations per row.
 * Four tokens spells "maria del carmen rodriguez"; six is slack on top.
 */
const MAX_QUERY_TOKENS = 6;

/**
 * Rows the caller's-edges pass may return. Bounded like every other fan-out in
 * this file: a hub account with thousands of connections must not turn one
 * keystroke into an unbounded read. Sized well above a page so the pass still
 * carries a real recall guarantee (see `searchProfiles`), and well below the
 * point where the candidate id list threatens SQLite's 999-variable ceiling in
 * the probes that follow.
 */
const MAX_CONNECTION_MATCH_ROWS = 50;

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
 * A query broken into the three forms the passes and the ranker each need.
 * Computed once per request rather than per candidate row.
 */
interface ParsedQuery {
  /** Normalised query verbatim — trimmed, `@`-stripped, lowercased. */
  readonly phrase: string;
  /** Word tokens: `"john smith"` -> `["john", "smith"]`. */
  readonly tokens: string[];
  /** Tokens rejoined handle-style: `"john smith"` -> `"johnsmith"`. */
  readonly handleQuery: string;
  /**
   * How much the caller actually typed: the summed length of the tokens,
   * whitespace excluded. **No length gate keys on `phrase.length`** — a gate
   * that counts separators is walked past by typing one, and `"a b"` would read
   * as three characters while carrying two.
   */
  readonly contentLength: number;
}

function parseQuery(raw: string): ParsedQuery {
  const phrase = normaliseHandleQuery(raw);
  const allTokens = tokeniseQuery(phrase);
  // Cap the token count before anything builds SQL from it. `q` is bounded at
  // 64 characters, which admits 32 single-character tokens — and every token
  // becomes its own ANDed pair of `LIKE` predicates, so an unbounded count
  // multiplies the per-row cost of the full-scan pass by up to 32x on a query
  // whose conjunction cannot match, meaning `LIMIT` never short-circuits it.
  // Real queries are names: four tokens covers "maria del carmen rodriguez".
  const tokens = allTokens.slice(0, MAX_QUERY_TOKENS);
  return {
    phrase,
    tokens,
    handleQuery: joinTokens(tokens),
    contentLength: tokenContentLength(tokens),
  };
}

/**
 * How well the *text* of a candidate matches the query, on a 0-100 scale.
 * Shared by profile and organisation search so the two lists score on the same
 * rules.
 *
 * The tiers, strongest first:
 *
 * | Score | Tier | Example for query `"smith"` |
 * |---|---|---|
 * | 100 | exact handle | `@smith` |
 * | 60 | handle prefix | `@smithers` |
 * | 50 | **name-token prefix** | `Roberta Smith` |
 * | 25 | handle infix | `@blacksmith` |
 * | 20 | name infix | `Blacksmith Ltd` |
 *
 * The name-token tier is the one that is new, and it is the tier that carries
 * most of the quality: before it, `"Roberta Smith"` scored as a name *infix* —
 * indistinguishable from `"Blacksmith Ltd"`, and below `@blacksmith`. Matching
 * any token of a name rather than only its first is what a name-based typeahead
 * has to do; surnames are not prefixes of full names.
 *
 * Numbers rather than an enum of tiers because these are summed with
 * {@link PROXIMITY_SCORE} — see `rankScore`.
 */
const LEXICAL_SCORE = {
  exactHandle: 100,
  handlePrefix: 60,
  nameTokenPrefix: 50,
  handleInfix: 25,
  nameInfix: 20,
  none: 0,
} as const;

/**
 * How close a candidate already is to the caller, on the same scale.
 *
 * This is the [Facebook typeahead][fb] ordering — first-degree results, then
 * results reachable through the caller's own graph, then everything else —
 * restricted to the two signals the caller can *already* see:
 *
 * - **Connection state.** Every result already carries `connectionStatus`, so
 *   ordering by it tells the caller nothing the payload doesn't.
 * - **Shared organisation.** Only ever counted for organisations the caller
 *   belongs to, and `GET /organisations/:handle/members` is visible to members —
 *   so the caller could enumerate exactly this set directly.
 *
 * **Friends-of-friends is deliberately absent**, though it is the strongest
 * signal Facebook's own ranking uses. Nothing in OSN exposes another profile's
 * connection list, so a mutual-connection boost would make result *ordering* an
 * oracle for "is this arbitrary handle a friend-of-a-friend?" — the same
 * disclosure that keeps `mutualCount` out of the search payload (see
 * `S-L4` in `xchromo/osn-tracker`). Ordering leaks as readily as a field does.
 *
 * [fb]: https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/
 */
const PROXIMITY_SCORE = {
  connected: 40,
  pending: 25,
  sharedOrganisation: 15,
  none: 0,
} as const;

function lexicalScore(handle: string, name: string | null, query: ParsedQuery): number {
  const { phrase, tokens, handleQuery } = query;
  if (handle === handleQuery) return LEXICAL_SCORE.exactHandle;
  if (handleQuery.length > 0 && handle.startsWith(handleQuery)) return LEXICAL_SCORE.handlePrefix;
  if (tokensPrefixName(name, tokens)) return LEXICAL_SCORE.nameTokenPrefix;
  if (handleQuery.length > 0 && handle.includes(handleQuery)) return LEXICAL_SCORE.handleInfix;
  const lowered = name?.toLowerCase() ?? "";
  if (lowered.includes(phrase)) return LEXICAL_SCORE.nameInfix;
  // Every token present but not as a phrase — `"smith john"` against
  // `"John Smith"`. Retrieval found it, so it must not fall out of ranking.
  if (lowered.length > 0 && tokens.length > 0 && tokens.every((t) => lowered.includes(t))) {
    return LEXICAL_SCORE.nameInfix;
  }
  return LEXICAL_SCORE.none;
}

/**
 * The final sort key: lexical score plus proximity score, strongest first, with
 * the lexical score alone breaking ties and the handle breaking those, so the
 * order is total and stable between identical requests.
 *
 * Additive rather than lexicographic (proximity-then-text, or text-then-
 * proximity) because neither pure ordering is right. Text-first would bury the
 * caller's own connections under strangers with a marginally better prefix —
 * the thing typeahead most needs to avoid. Proximity-first would let a
 * connection matched only on a name infix outrank a stranger whose handle the
 * caller typed in full. Summing lets a strong enough text match outweigh
 * proximity and vice versa: an exact handle (100) beats a connected handle
 * prefix (60 + 40) on the lexical tie-break, while a connected name-token match
 * (50 + 40) beats a stranger's handle prefix (60).
 */
function compareRanked<T extends { handle: string; score: number; lexical: number }>(
  a: T,
  b: T,
): number {
  return b.score - a.score || b.lexical - a.lexical || (a.handle < b.handle ? -1 : 1);
}

/**
 * `every token appears in at least one of these columns`, as SQL.
 *
 * AND across tokens rather than one `%phrase%` pattern: `"smith john"` should
 * find `"John Smith"`, and no single substring pattern can express that. Each
 * token keeps its own `ESCAPE` clause so a typed `_` still matches literally.
 */
function containsAllTokens(tokens: string[], ...columns: SQLiteColumn[]) {
  return and(
    ...tokens.map((token) => {
      const pattern = likeContains(token);
      return or(...columns.map((column) => sql`${column} LIKE ${pattern} ESCAPE '\\'`));
    }),
  );
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
   * **Retrieval** runs three passes, each cheap and each bounded, in the
   * tiering [Facebook's typeahead][fb] describes — the caller's own edges
   * first, then the global index:
   *
   * 0. **The caller's edges.** An index seek on `connections_requester_idx` /
   *    `connections_addressee_idx` joined to `users`, matched loosely (every
   *    query token appearing anywhere in handle or display name). It is the
   *    only pass allowed to run at one character, because the set it reads is
   *    one the caller can already list via `GET /graph/connections`.
   * 1. **Global handle prefix.** An index **seek** over the handle range (see
   *    `handlePrefixRange` — a plain `LIKE 'q%'` would silently full-scan).
   *    Answers the common typeahead case.
   * 2. **Global infix.** An unanchored `%token%` match over handle + display
   *    name. No index can serve a leading wildcard, so it is a full scan and is
   *    gated twice: only when the passes above under-fill the page *and* the
   *    query is at least `MIN_INFIX_QUERY_LENGTH` characters. Two-char queries
   *    are both the cheapest to abuse and the least useful to scan for.
   *
   * Pass 0 is not a duplicate of passes 1-2: it is a **recall guarantee**.
   * Every global pass is `ORDER BY handle LIMIT overfetch`, so a common prefix
   * fills the window with whoever sorts alphabetically first — search `"al"` on
   * a large instance and `@alice`, a connection, loses her slot to two dozen
   * strangers she happens to sort behind. A caller's connections are few enough
   * to retrieve unconditionally, so they never depend on that window.
   *
   * **Ranking** then scores each candidate on text match plus social proximity
   * (`lexicalScore` + `PROXIMITY_SCORE`) and slices the page. Scoring the whole
   * candidate set before slicing — rather than slicing on text alone and
   * annotating the survivors, as this did before — is what lets proximity
   * change *which* results appear, not merely their order within a page that
   * had already been chosen without it.
   *
   * Privacy: results carry nothing beyond the public profile fields plus the
   * caller's *own* connection state with each result — the same thing
   * `GET /graph/connections/:handle` already reports per handle, batched. No
   * mutual counts here, and no friends-of-friends *ranking* either; see
   * {@link PROXIMITY_SCORE} for why ordering by that would be the same
   * disclosure as returning it.
   *
   * [fb]: https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/
   */
  const searchProfiles = (
    profileId: string,
    rawQuery: string,
    limit = 8,
  ): Effect.Effect<ProfileSearchResult[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 8, 1), 20);

      const query = parseQuery(rawQuery);
      // Below the minimum we return an empty list rather than an error — a
      // single keystroke shouldn't be a 4xx, and the empty result is what keeps
      // the enumeration surface small.
      if (query.contentLength < MIN_SEARCH_QUERY_LENGTH) return [];

      const overfetch = safeLimit * SEARCH_OVERFETCH_FACTOR;
      const containsQuery = containsAllTokens(query.tokens, users.handle, users.displayName);

      const selectGlobal = (where: ReturnType<typeof and>, rows: number) =>
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

      /**
       * Pass 0, one side of the edge. Two queries rather than one with an `OR`
       * in the join condition: SQLite will not use `connections_requester_idx`
       * and `connections_addressee_idx` for a disjunction spanning both, and a
       * pass whose whole justification is being cheap must not degrade into a
       * scan of the connections table.
       */
      const selectConnected = (mine: SQLiteColumn, theirs: SQLiteColumn) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({
                id: users.id,
                handle: users.handle,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
              })
              .from(connections)
              .innerJoin(users, eq(users.id, theirs))
              .innerJoin(accounts, eq(users.accountId, accounts.id))
              .where(
                and(
                  eq(mine, profileId),
                  isNull(accounts.deletedAt),
                  ne(users.id, profileId),
                  containsQuery,
                ),
              )
              .orderBy(asc(users.handle))
              .limit(MAX_CONNECTION_MATCH_ROWS),
          catch: (cause) => new DatabaseError({ cause }),
        });

      const range = handlePrefixRange(query.handleQuery);
      const runGlobal = query.handleQuery.length >= MIN_GLOBAL_QUERY_LENGTH;
      const matched = new Map<string, ProfileRow>();

      // Passes 0 and 1 are independent — concurrent on D1, sequential on
      // bun:sqlite. Pass 2 depends on how full they leave the page.
      const [sentRows, receivedRows, prefixRows] = yield* Effect.all(
        [
          selectConnected(connections.requesterId, connections.addresseeId),
          selectConnected(connections.addresseeId, connections.requesterId),
          range && runGlobal
            ? selectGlobal(
                and(gte(users.handle, range.lower), lt(users.handle, range.upper)),
                overfetch,
              )
            : Effect.succeed([] as ProfileRow[]),
        ],
        { concurrency: "unbounded" },
      );

      for (const row of [...sentRows, ...receivedRows, ...prefixRows]) matched.set(row.id, row);

      // Pass 2 — the full scan. Gated on the page not being full AND on a query
      // long enough to be worth scanning for.
      if (matched.size < safeLimit && hasScanworthyToken(query.tokens, MIN_INFIX_QUERY_LENGTH)) {
        for (const row of yield* selectGlobal(containsQuery, overfetch)) {
          matched.set(row.id, row);
        }
      }

      if (matched.size === 0) return [];

      const candidateIds = [...matched.keys()];
      const memberships = alias(organisationMembers, "caller_memberships");

      // The three probes that turn candidates into ranked results. All scoped
      // to the candidate ids, all index-served, and all independent of each
      // other — one concurrent step rather than the two sequential ones this
      // took before.
      const [blockRows, edgeRows, sharedOrgRows] = yield* Effect.all(
        [
          // Blocks are probed against the candidate ids, not read wholesale for
          // the caller: an unbounded read to filter at most a few hundred rows
          // scales with how many people the caller has blocked rather than with
          // anything the request needs. Both `blocks_blocker_idx` and
          // `blocks_blocked_idx` serve this.
          Effect.tryPromise({
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
          }),
          // The caller's own connection state with each candidate — both the
          // `connectionStatus` the response carries and the proximity term the
          // ranker adds, in one query for the whole candidate set.
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
                    and(
                      eq(connections.requesterId, profileId),
                      inArray(connections.addresseeId, candidateIds),
                    ),
                    and(
                      eq(connections.addresseeId, profileId),
                      inArray(connections.requesterId, candidateIds),
                    ),
                  ),
                ),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          // Candidates who share an organisation with the caller. A self-join
          // rather than "read my orgs, then read their members": the caller's
          // org ids would be a second round trip on the critical path of a
          // keystroke, and `org_members_profile_idx` / `org_members_org_idx`
          // serve both sides of this in one.
          Effect.tryPromise({
            try: () =>
              db
                .selectDistinct({ profileId: organisationMembers.profileId })
                .from(memberships)
                .innerJoin(
                  organisationMembers,
                  eq(organisationMembers.organisationId, memberships.organisationId),
                )
                .where(
                  and(
                    eq(memberships.profileId, profileId),
                    inArray(organisationMembers.profileId, candidateIds),
                  ),
                ),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      for (const row of blockRows) {
        matched.delete(row.blockerId === profileId ? row.blockedId : row.blockerId);
      }
      if (matched.size === 0) return [];

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

      const sharesOrganisation = new Set(sharedOrgRows.map((r) => r.profileId));

      const proximityScore = (id: string): number => {
        const state = stateById.get(id);
        if (state === "connected") return PROXIMITY_SCORE.connected;
        if (state === "pending_sent" || state === "pending_received")
          return PROXIMITY_SCORE.pending;
        if (sharesOrganisation.has(id)) return PROXIMITY_SCORE.sharedOrganisation;
        return PROXIMITY_SCORE.none;
      };

      return [...matched.values()]
        .map((row) => {
          const lexical = lexicalScore(row.handle, row.displayName, query);
          return { row, lexical, handle: row.handle, score: lexical + proximityScore(row.id) };
        })
        .toSorted(compareRanked)
        .slice(0, safeLimit)
        .map(({ row }) => ({
          handle: row.handle,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
          connectionStatus: stateById.get(row.id) ?? "none",
        }));
    }).pipe(Effect.withSpan("recommendations.search_profiles"));

  /**
   * Autocomplete-oriented organisation search over handle and name. Same shape
   * as `searchProfiles` and the same gating: the caller's own organisations
   * first (the pass that runs at one character, over a set the caller can
   * already list), then the global handle-range seek, then the unanchored
   * full-scan pass only when those under-fill the page and the query is long
   * enough to be worth scanning for.
   *
   * No exclusions beyond the query itself: organisations are public entities
   * with a handle in the same namespace as user handles, and the caller's own
   * organisations are *more* relevant in a search box, not less — they come
   * back flagged `isMember: true` so the row can say so, and now rank above
   * strangers on the same lexical tier rather than merely being labelled.
   */
  const searchOrganisations = (
    profileId: string,
    rawQuery: string,
    limit = 5,
  ): Effect.Effect<OrganisationSearchResult[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 5, 1), 20);

      const query = parseQuery(rawQuery);
      if (query.contentLength < MIN_SEARCH_QUERY_LENGTH) return [];

      const overfetch = safeLimit * SEARCH_OVERFETCH_FACTOR;
      const containsQuery = containsAllTokens(
        query.tokens,
        organisations.handle,
        organisations.name,
      );

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

      const range = handlePrefixRange(query.handleQuery);
      const runGlobal = query.handleQuery.length >= MIN_GLOBAL_QUERY_LENGTH;
      const matches = new Map<
        string,
        { id: string; handle: string; name: string; avatarUrl: string | null }
      >();

      // Pass 0 (the caller's own organisations) and pass 1 (the global handle
      // range) are independent — concurrent on D1.
      const [memberRows, prefixRows] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () =>
              db
                .select({
                  id: organisations.id,
                  handle: organisations.handle,
                  name: organisations.name,
                  avatarUrl: organisations.avatarUrl,
                })
                .from(organisationMembers)
                .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
                .where(and(eq(organisationMembers.profileId, profileId), containsQuery))
                .orderBy(asc(organisations.handle))
                .limit(MAX_MY_ORGANISATIONS),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          range && runGlobal
            ? selectMatching(
                and(gte(organisations.handle, range.lower), lt(organisations.handle, range.upper)),
                overfetch,
              )
            : Effect.succeed(
                [] as { id: string; handle: string; name: string; avatarUrl: string | null }[],
              ),
        ],
        { concurrency: "unbounded" },
      );

      for (const row of [...memberRows, ...prefixRows]) matches.set(row.id, row);

      if (matches.size < safeLimit && hasScanworthyToken(query.tokens, MIN_INFIX_QUERY_LENGTH)) {
        for (const row of yield* selectMatching(containsQuery, overfetch)) {
          matches.set(row.id, row);
        }
      }

      if (matches.size === 0) return [];

      // One membership probe for the whole candidate set — before the slice,
      // not after, so membership can change which organisations make the page
      // rather than only how the chosen ones are labelled.
      const membershipRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ organisationId: organisationMembers.organisationId })
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.profileId, profileId),
                inArray(organisationMembers.organisationId, [...matches.keys()]),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const memberOf = new Set(membershipRows.map((r) => r.organisationId));

      return [...matches.values()]
        .map((row) => {
          const lexical = lexicalScore(row.handle, row.name, query);
          return {
            row,
            lexical,
            handle: row.handle,
            score: lexical + (memberOf.has(row.id) ? PROXIMITY_SCORE.sharedOrganisation : 0),
          };
        })
        .toSorted(compareRanked)
        .slice(0, safeLimit)
        .map(({ row }) => ({
          handle: row.handle,
          name: row.name,
          avatarUrl: row.avatarUrl,
          isMember: memberOf.has(row.id),
        }));
    }).pipe(Effect.withSpan("recommendations.search_organisations"));

  return { suggestConnections, searchProfiles, searchOrganisations };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
