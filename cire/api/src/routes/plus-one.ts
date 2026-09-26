import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { sessionAuth } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { PlusOneNameBody } from "../schemas/plus-one";
import { plusOneService } from "../services/plus-one";

// A name body is two short strings. Refuse anything far larger before paying
// to parse it; the schema is the real bound.
const MAX_PLUS_ONE_BYTES = 4 * 1024;

/** The refusals both guest routes share, as `{ status, error }`. The error
 *  strings are machine-readable codes the invite maps to its own copy. */
const GUEST_REFUSALS = {
  PlusOneHouseholdGone: { status: 403, error: "Unauthorized" },
  PlusOnePreview: { status: 403, error: "Preview sessions cannot change plus-ones" },
  PlusOneRsvpClosed: { status: 403, error: "rsvp_closed" },
  PlusOneGuestNotFound: { status: 404, error: "guest_not_found" },
  PlusOneCannotInvite: { status: 409, error: "plus_one_cannot_invite" },
  PlusOneNotAllowed: { status: 403, error: "plus_one_not_allowed" },
  CapacityExceeded: { status: 409, error: "guest_capacity" },
} as const;

/**
 * The household's plus-ones ([[wiki/cire/cire-plus-ones]]):
 *
 *   PUT    /api/plus-one/:guestId  { firstName, lastName }
 *   DELETE /api/plus-one/:guestId
 *
 * `:guestId` is the household member bringing the plus-one, not the plus-one.
 * PUT names them, or renames the one already named; DELETE removes them.
 *
 * Behind the household session cookie, like `POST /api/rsvp`, and no Turnstile
 * for the same reason: the cookie came from a Turnstile-gated `/api/claim`. A
 * per-IP limiter caps the write rate, as on the guest registry writes. The
 * CSRF origin guard covers both methods. The service keys every read and write
 * on the session's `familyId`, and refuses the host preview, a closed RSVP
 * window, a guest outside the household, a plus-one bringing a plus-one, a
 * member without permission and a wedding at its guest cap.
 */
export const createPlusOneRoutes = (db: Db, deps: { limiter: RateLimiterBackend }) =>
  new Elysia({ prefix: "/api/plus-one" })
    .use(sessionAuth(db))
    .use(rateLimitMiddleware(deps.limiter))
    .put(
      "/:guestId",
      async ({ request, params, familyId, set }) => {
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
        if (Number.isFinite(declared) && declared > MAX_PLUS_ONE_BYTES) {
          set.status = 413;
          return { error: "Payload too large" };
        }
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknownEffect(PlusOneNameBody)(raw);
            return yield* plusOneService.save(familyId, params.guestId, body);
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("SchemaError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
            Effect.catch((e) =>
              Effect.sync(() => {
                const refusal = GUEST_REFUSALS[e._tag];
                set.status = refusal.status;
                return { error: refusal.error };
              }),
            ),
          ),
        );
      },
      // Sentinel parse hook: the handler parses the body itself, so a malformed
      // payload degrades to the schema's 400 instead of Elysia's parser error.
      { parse: () => ({}) },
    )
    .delete("/:guestId", ({ params, familyId, set }) => {
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      return runCire(
        plusOneService.remove(familyId, params.guestId).pipe(
          Effect.provideService(DbService, db),
          Effect.catch((e) =>
            Effect.sync(() => {
              const refusal = GUEST_REFUSALS[e._tag];
              set.status = refusal.status;
              return { error: refusal.error };
            }),
          ),
        ),
      );
    });
