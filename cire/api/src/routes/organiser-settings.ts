import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { metricSettingsOwnerOnlyRefused } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { ownerOnlySettingsIn, UpdateSettingsBody } from "../schemas/settings";
import { weddingSettingsService } from "../services/wedding-settings";

// Sentinel parse hook — same idiom as the other organiser POST/PUT routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

/**
 * Wedding-profile Settings routes (platform Phase 0), mounted under
 * /api/organiser/weddings/:weddingId. Siblings by authorisation level,
 * mirroring the organiser-weddings factory:
 *  - GET /settings — weddingMember() (any role incl. viewer; read-only).
 *  - PUT /settings — weddingEditor(), then a FIELD-level owner check: wedding
 *    identity + money stay owner-only in the roles matrix (platform-plan §3.5),
 *    but the RSVP deadline is editable by an `editor` co-host. The gate can't
 *    express that on its own, so the route splits it: the middleware decides
 *    who may reach the handler at all (a `viewer` still gets its 403
 *    `read_only_role`), and the handler rejects a non-owner patch that reaches
 *    past the deadline with 403 `owner_only_fields`. Rejected, never silently
 *    dropped — a save that reports success while discarding half the form is
 *    the worse failure.
 *
 * There is no separate event "location config" here: an event's place is its
 * free-text `address` (the sole location source the guest map renders). The
 * stored coordinates + pricing region that used to live on `events` (and the
 * geocode endpoint that fed them) were removed by migration 0036 — they only
 * ever served unbuilt Phase 3 planning features.
 */
export const createOrganiserSettingsRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) => {
  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/settings", ({ weddingId, set }) => {
        if (!weddingId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        return runCire(
          weddingSettingsService.get(weddingId).pipe(
            Effect.provideService(DbService, db),
            Effect.map((wedding) => ({ wedding })),
            Effect.catchTag("WeddingNotFound", () =>
              Effect.sync(() => {
                set.status = 404;
                return { error: "wedding_not_found" };
              }),
            ),
            Effect.catchAllDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      }),
    )
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingEditor(db)).put(
        "/settings",
        async ({ weddingId, weddingIsOwner, osnProfileId, request, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const raw: unknown = await request.json().catch(() => null);
          return runCire(
            Effect.gen(function* () {
              const patch = yield* Schema.decodeUnknown(UpdateSettingsBody)(raw);
              // Shape first, then privilege: a malformed body is a 400 whoever
              // sent it, so a co-host debugging a typo isn't told "forbidden".
              const ownerOnly = weddingIsOwner ? [] : ownerOnlySettingsIn(patch);
              if (ownerOnly.length > 0) {
                // The portal never sends this body — a co-host's save carries
                // the deadline pair alone — so every occurrence is a stale tab
                // or a hand-crafted call, which is exactly the shape of a
                // co-host probing owner-only fields. Log the field NAMES (a
                // closed set from the schema, never caller-controlled text);
                // the caller's id stays out of it, per the redaction rules.
                yield* Effect.logWarning("settings owner-only fields refused", {
                  weddingId,
                  fields: ownerOnly,
                });
                metricSettingsOwnerOnlyRefused();
                set.status = 403;
                return { error: "owner_only_fields", fields: ownerOnly };
              }
              const wedding = yield* weddingSettingsService.update(weddingId, patch, osnProfileId);
              return { wedding };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTags({
                ParseError: () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                WeddingNotFound: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "wedding_not_found" };
                  }),
                // A backdated deadline would lock the invite for every guest the
                // moment it landed, and a guest turned away is never told the
                // date moved. Refused for every caller, owner included — "today"
                // stays available, since the deadline closes at the END of its
                // day (S-L3).
                RsvpDeadlineInPast: () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "rsvp_deadline_in_past" };
                  }),
                SettingsWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not save settings" };
                  }),
              }),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        },
        manualParse,
      ),
    );
};
