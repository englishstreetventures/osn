import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { decideCapability } from "../middleware/wedding-role";
import { runCire } from "../observability";
import { MarkRsvpChangesSeenBody, RsvpDigestBody } from "../schemas/rsvp-changes";
import { rsvpChangeService } from "../services/rsvp-changes";

// Sentinel parse hook — same idiom as the other organiser write routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

const internalError = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

const invalidBody = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

/**
 * RSVP changes — READ surface, and the caller's own read marker:
 *
 *   GET  /api/organiser/weddings/:weddingId/rsvp-changes       (weddingMember)
 *   GET  /api/organiser/weddings/:weddingId/rsvp-changes/rows  (weddingMember)
 *   POST /api/organiser/weddings/:weddingId/rsvp-changes/seen  (weddingMember)
 *
 * Every role that reads the RSVPs (owner, editor, viewer) gets the feed. The
 * Overview card reads the first (a count, the latest households, the digest
 * switch); the RSVP table reads the second (the rows to badge, and the
 * marker that covers exactly those), so neither downloads what it never
 * shows, and the card is never handed a marker to post back. The
 * POST is behind the read gate because it writes only the caller's own row in
 * `host_rsvp_notices` — no wedding data — and a viewer has changes to mark
 * seen like anyone else. Split from the write factory so the two gates never
 * share a chain, as the tasks and hosts routes are.
 *
 * `digest.available` is the policy table's answer to "does this caller get the
 * daily email" (the `editor` capability), so the portal shows the switch
 * without deciding anything from a role itself. `digest.enabled` is the
 * caller's own setting, which the card's gate reads in the statement that finds
 * their seat (`weddingMember(db, { rsvpDigest: true })`). That wider gate sits
 * in a group of its own; the table's read and the seen POST stay behind the
 * plain member gate in a sibling group, and neither group's gate runs in front
 * of the other's routes. The body names households, so no intermediary may
 * keep it.
 */
export const createOrganiserRsvpChangeReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db, { rsvpDigest: true }))
        .get(
          "/rsvp-changes",
          ({ weddingId, weddingRole, weddingRsvpDigest, osnProfileId, set }) => {
            if (!weddingId || !weddingRole || !osnProfileId || weddingRsvpDigest === undefined) {
              set.status = 500;
              return { error: "Internal error" };
            }
            return runCire(
              rsvpChangeService.feed(weddingId, osnProfileId).pipe(
                Effect.map((feed) => {
                  set.headers["cache-control"] = "no-store";
                  return {
                    ...feed,
                    digest: {
                      available: decideCapability(weddingRole, "editor").allowed,
                      enabled: weddingRsvpDigest,
                    },
                  };
                }),
                Effect.provideService(DbService, db),
                Effect.catchTag("RsvpChangeError", () => internalError(set)),
                Effect.catchDefect(() => internalError(set)),
              ),
            );
          },
        ),
    )
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .get("/rsvp-changes/rows", ({ weddingId, osnProfileId, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            rsvpChangeService.unseenRows(weddingId, osnProfileId).pipe(
              Effect.map((rows) => {
                set.headers["cache-control"] = "no-store";
                return rows;
              }),
              Effect.provideService(DbService, db),
              Effect.catchTag("RsvpChangeError", () => internalError(set)),
              Effect.catchDefect(() => internalError(set)),
            ),
          );
        })
        .post(
          "/rsvp-changes/seen",
          async ({ weddingId, osnProfileId, request, set }) => {
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(MarkRsvpChangesSeenBody)(raw);
                const seenSeq = yield* rsvpChangeService.markSeen(
                  weddingId,
                  osnProfileId,
                  body.seq,
                );
                return { seenSeq };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () => invalidBody(set)),
                Effect.catchTag("RsvpChangeError", () => internalError(set)),
                Effect.catchDefect(() => internalError(set)),
              ),
            );
          },
          manualParse,
        ),
    );

/**
 * RSVP changes — WRITE surface:
 *
 *   PUT /api/organiser/weddings/:weddingId/rsvp-changes/digest  (weddingEditor)
 *
 * The caller's own daily digest, on or off, for this wedding. Only the owner
 * and editors are ever sent one, so only they may set it; a viewer gets 403
 * `read_only_role` from the gate.
 */
export const createOrganiserRsvpChangeWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingEditor(db)).put(
        "/rsvp-changes/digest",
        async ({ weddingId, osnProfileId, request, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const raw: unknown = await request.json().catch(() => null);
          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknownEffect(RsvpDigestBody)(raw);
              const enabled = yield* rsvpChangeService.setDigest(
                weddingId,
                osnProfileId,
                body.enabled,
              );
              return { enabled };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("SchemaError", () => invalidBody(set)),
              Effect.catchTag("RsvpChangeError", () => internalError(set)),
              Effect.catchDefect(() => internalError(set)),
            ),
          );
        },
        manualParse,
      ),
    );
