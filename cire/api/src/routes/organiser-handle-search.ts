import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import type { OsnHandleSearchResolver } from "../services/osn-bridge";

const PREFIX = "/api/organiser";

/**
 * Handle autocomplete for the add-co-host input. NOT wedding-scoped — it answers
 * "which OSN profiles start with this prefix?", which any signed-in organiser may
 * ask while typing a co-host's handle. So it's gated by `osnAuth()` only (a valid
 * OSN access token), never `weddingOwner()`: the suggestion list isn't tied to a
 * wedding, and gating per-wedding would wrongly block an organiser autocompleting
 * before they've picked which wedding to add the host to.
 *
 * Behaviour mirrors the host-list display path: KEY-OPTIONAL + FAIL-SOFT. When
 * the ARC search resolver is absent (no ARC key) or the lookup is unavailable,
 * the route returns an empty list — the manual type-and-submit add path on the
 * POST /hosts endpoint still works, autocomplete just suggests nothing. Never a
 * 503/500 for an autocomplete miss.
 *
 * Enumeration guardrails live in osn-api (min prefix length, ordered + capped
 * results, graph:read ARC gate); this route adds a light per-IP rate limit so an
 * authenticated organiser can't drive unbounded ARC-sign + S2S amplification by
 * spamming keystrokes.
 */
export const createOrganiserHandleSearchRoutes = (
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnHandleSearch?: OsnHandleSearchResolver,
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

      const q = typeof query.q === "string" ? query.q : "";
      // No ARC key configured, or empty query — suggest nothing. Not an error:
      // the manual add path is unaffected. osn-api owns the min-length floor, so
      // a 1-char query simply comes back empty from upstream.
      if (!resolveOsnHandleSearch || q.trim().length === 0) {
        return { profiles: [] };
      }
      const resolveSearch = resolveOsnHandleSearch;

      return runCire(
        Effect.tryPromise({
          try: () => resolveSearch(q),
          catch: () => null,
        }).pipe(
          // FAIL-SOFT: the resolver already swallows transport failures to an
          // empty list; this orElse is a belt-and-braces guard for the same.
          Effect.orElseSucceed(() => null),
          Effect.map((suggestions) => ({ profiles: suggestions ?? [] })),
        ),
      );
    });
