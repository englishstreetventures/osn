import { normaliseHandleQuery } from "@shared/db-utils/search";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import type { OsnConnectionSearchResolver, OsnHandleSearchResolver } from "../services/osn-bridge";

const PREFIX = "/api/organiser";

/** Max suggestions returned, however many sources contributed to them. */
const MAX_SUGGESTIONS = 8;

/**
 * Shortest query the GLOBAL handle search can answer with anything. osn-api's
 * `/graph/internal/profile-search` floors at 2 characters *after* stripping the
 * `@`, so a shorter query is a signature plus a round trip to be told "empty".
 * Mirrored here — via the same `normaliseHandleQuery` that endpoint uses, so the
 * two floors stay in lockstep by construction rather than by comment.
 *
 * The CONNECTION source has no such floor: it searches one organiser's own
 * graph, where even a single character narrows a list they can already read.
 */
const MIN_GLOBAL_SEARCH_LEN = 2;

/** One suggestion as the organiser portal consumes it. */
interface Suggestion {
  profileId: string;
  handle: string;
  displayName: string | null;
  /**
   * True when this profile is one of the caller's own OSN connections. Drives
   * the portal's "Connected" badge and the grouping in the dropdown — an
   * organiser about to hand someone write access to their guest list wants to
   * see, before they click, whether this is the person they actually know.
   */
  connected: boolean;
}

/**
 * Handle autocomplete for the add-co-host input. NOT wedding-scoped — it answers
 * "who might this organiser mean?", which any signed-in organiser may ask while
 * typing a co-host's handle. So it's gated by `osnAuth()` only (a valid OSN
 * access token), never `weddingOwner()`: the suggestion list isn't tied to a
 * wedding, and gating per-wedding would wrongly block an organiser autocompleting
 * before they've picked which wedding to add the host to.
 *
 * Two sources, deliberately ordered:
 *
 *   1. The caller's own **OSN connections** (`resolveOsnConnectionSearch`),
 *      matched on handle prefix or display-name substring. These come first
 *      because a wedding's co-hosts are nearly always people the organiser
 *      already knows on OSN — a partner, a sibling, the planner they connected
 *      with — and because picking a connection is the case where the organiser
 *      can be confident they've got the right @handle rather than a stranger
 *      with a confusable one.
 *   2. The global handle prefix search (`resolveOsnHandleSearch`), which fills
 *      the remainder. Kept because a co-host is *not required* to be a
 *      connection, and dropping it would turn "not connected yet" into "cannot
 *      be added" — a regression for exactly the planner-hired-last-week case.
 *
 * A profile that appears in both is emitted once, from the connections source,
 * so `connected` is never understated.
 *
 * The caller's own profile is filtered out of both: the owner already hosts the
 * wedding (`POST /hosts` answers 409 `owner_is_host`), so suggesting themselves
 * only leads to a dead end.
 *
 * Behaviour mirrors the host-list display path: KEY-OPTIONAL + FAIL-SOFT. With
 * no ARC resolvers (no ARC key) or an unavailable lookup, the route returns an
 * empty list — the manual type-and-submit add path on `POST /hosts` still works,
 * autocomplete just suggests nothing. Never a 503/500 for an autocomplete miss.
 *
 * An EMPTY query is valid and is not the same as a missing one: it returns the
 * organiser's first page of connections and nothing from the global search,
 * which is what lets the portal open its dropdown on focus, before a keystroke.
 * Enumeration guardrails (min prefix length on the global search, ordering,
 * result caps) live in osn-api; this route adds a light per-IP rate limit so an
 * authenticated organiser can't drive unbounded ARC-sign + S2S amplification by
 * spamming keystrokes.
 */
export const createOrganiserHandleSearchRoutes = (
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnHandleSearch?: OsnHandleSearchResolver,
  resolveOsnConnectionSearch?: OsnConnectionSearchResolver,
) =>
  new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    .use(rateLimitMiddleware(limiter))
    .get("/handle-search", async ({ query, set, osnProfileId }) => {
      // osnAuth derives osnProfileId on every request; guard so a future remount
      // without the plugin can't serve this unauthenticated.
      if (!osnProfileId) {
        set.status = 401;
        return { error: "unauthorised" };
      }
      const viewerId = osnProfileId;

      const q = typeof query.q === "string" ? query.q : "";
      // Normalised the way osn-api will normalise it, so the global source's
      // minimum-length decision is made on the same string osn-api would floor.
      const normalised = normaliseHandleQuery(q);

      // Nothing configured at all — suggest nothing. Not an error: the manual
      // add path is unaffected.
      if (!resolveOsnConnectionSearch && !resolveOsnHandleSearch) {
        return { profiles: [] };
      }

      const connectionSearch = resolveOsnConnectionSearch;
      const handleSearch = resolveOsnHandleSearch;

      return runCire(
        Effect.tryPromise({
          try: async (): Promise<Suggestion[]> => {
            // Both lookups are independent S2S calls — run them concurrently so
            // the dropdown's latency is the slower of the two, not their sum.
            // The global search is skipped below its own minimum length: osn-api
            // floors at 2 characters, so a shorter query would cost an ARC
            // signature and a round trip to be handed back an empty list. That
            // includes the empty on-focus query, which is meant to show
            // connections only.
            //
            // Each source is caught INDEPENDENTLY, not with a single
            // `Promise.all` + outer catch: one failing lookup must degrade only
            // itself. Losing the global search should still leave the organiser
            // their connections, and losing connections should still let them
            // find someone by typing a handle in full — collapsing both to empty
            // because one 5xx'd is a strictly worse outcome than either half.
            // (The ARC resolvers already swallow their own failures, so this is
            // the second line of that defence, not the first.)
            const [connections, handles] = await Promise.all([
              connectionSearch
                ? connectionSearch(viewerId, q).catch(() => [])
                : Promise.resolve([]),
              handleSearch && normalised.length >= MIN_GLOBAL_SEARCH_LEN
                ? handleSearch(q).catch(() => [])
                : Promise.resolve([]),
            ]);

            const out: Suggestion[] = [];
            // Seeded with the caller so they can't be suggested to themselves,
            // and so the dedupe below needs only the one set.
            const seen = new Set<string>([viewerId]);

            for (const c of connections) {
              if (out.length >= MAX_SUGGESTIONS) break;
              if (seen.has(c.profileId)) continue;
              seen.add(c.profileId);
              out.push({
                profileId: c.profileId,
                handle: c.handle,
                displayName: c.displayName,
                connected: true,
              });
            }
            for (const h of handles) {
              if (out.length >= MAX_SUGGESTIONS) break;
              if (seen.has(h.profileId)) continue;
              seen.add(h.profileId);
              out.push({
                profileId: h.profileId,
                handle: h.handle,
                displayName: h.displayName,
                connected: false,
              });
            }
            return out;
          },
          catch: () => null,
        }).pipe(
          // FAIL-SOFT: both resolvers already swallow transport failures to an
          // empty list; this orElse is a belt-and-braces guard for the same.
          Effect.orElseSucceed(() => null),
          Effect.map((suggestions) => ({ profiles: suggestions ?? [] })),
        ),
      );
    });
