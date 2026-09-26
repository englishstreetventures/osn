import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { runCire } from "../observability";
import { GuestPlusOnePermissionBody, HouseholdPlusOnePermissionBody } from "../schemas/plus-one";
import { plusOneService } from "../services/plus-one";

// Sentinel parse hook — same idiom as the other organiser PUT routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

const ORGANISER_REFUSALS = {
  PlusOneGuestNotFound: { status: 404, error: "guest_not_found" },
  PlusOneFamilyNotFound: { status: 404, error: "family_not_found" },
  PlusOneCannotInvite: { status: 409, error: "plus_one_cannot_invite" },
  PlusOneNamed: { status: 409, error: "plus_one_named" },
} as const;

/**
 * The refusal body for a service failure. `plus_one_named` also says how many
 * plus-ones the remove flag would delete, so the portal can name the cost
 * before asking again.
 */
function refuse(
  e: { readonly _tag: keyof typeof ORGANISER_REFUSALS; readonly named?: number },
  set: { status?: number | string },
): { error: string; named?: number } {
  const refusal = ORGANISER_REFUSALS[e._tag];
  set.status = refusal.status;
  return e.named === undefined
    ? { error: refusal.error }
    : { error: refusal.error, named: e.named };
}

/**
 * Who may bring a plus-one ([[wiki/cire/cire-plus-ones]]):
 *
 *   PUT /api/organiser/weddings/:weddingId/guests/:guestId/plus-one
 *       { allowed, removePlusOne? }
 *   PUT /api/organiser/weddings/:weddingId/families/:familyId/plus-one
 *       { allowed, removePlusOnes? }
 *
 * The first sets one guest's permission; the second sets it for every member of
 * a household. Turning it off where a plus-one is already named answers 409
 * `plus_one_named` unless the remove flag is set, and with it the plus-one and
 * their replies are deleted in the same batch. That delete is outside the change
 * history (no preview, no revert), which is why it is never implied by
 * `allowed: false` alone.
 *
 * Gated `weddingEditor()`, like every guest-list write: owner or editor; a
 * viewer gets 403 `read_only_role`. The service re-checks the guest or household
 * in wedding scope. The RSVP deadline does not gate these — the organiser owns
 * the date, as on the organiser RSVP route.
 */
export const createOrganiserPlusOneRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .put(
          "/guests/:guestId/plus-one",
          async ({ weddingId, params, request, set }) => {
            // weddingEditor() always derives this; the guard keeps a future
            // remount without the plugin from compiling into an unscoped write.
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(GuestPlusOnePermissionBody)(raw);
                return yield* plusOneService.setGuestPermission({
                  weddingId,
                  guestId: params.guestId,
                  allowed: body.allowed,
                  removePlusOne: body.removePlusOne,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catch((e) => Effect.sync(() => refuse(e, set))),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/families/:familyId/plus-one",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(HouseholdPlusOnePermissionBody)(raw);
                return yield* plusOneService.setHouseholdPermission({
                  weddingId,
                  familyId: params.familyId,
                  allowed: body.allowed,
                  removePlusOnes: body.removePlusOnes,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catch((e) => Effect.sync(() => refuse(e, set))),
              ),
            );
          },
          manualParse,
        ),
    );
