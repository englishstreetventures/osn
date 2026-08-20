import { families, guests, guestEvents, weddings } from "@cire/db";
import type { TurnstileVerifier } from "@shared/turnstile";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { isRsvpClosed } from "../lib/rsvp-deadline";
import { metricRsvpBatchSize, metricRsvpBlocked } from "../metrics";
import { sessionAuth } from "../middleware/auth";
import { turnstileGate } from "../middleware/turnstile";
import { runCire } from "../observability";
import { BulkRsvpBody } from "../schemas/rsvp";
import { rsvpService } from "../services/rsvp";

// S-L2: RSVP payloads are small (a family's worth of events). Reject obviously
// oversized requests before we pay for JSON parsing — mirrors the import route's
// Content-Length pre-check. The Schema (dietary/array bounds) is the real cap;
// this is a cheap upfront guard against a CDN that strips/lies notwithstanding.
const MAX_RSVP_BYTES = 256 * 1024;

export interface RsvpRouteOptions {
  /**
   * Turnstile verifier (KEY-OPTIONAL). `null` ⇒ gate skipped; configured ⇒ a
   * missing/invalid token fails closed (403) after auth, before any write.
   */
  turnstileVerifier?: TurnstileVerifier | null;
}

export const createRsvpRoutes = (db: Db, { turnstileVerifier = null }: RsvpRouteOptions = {}) =>
  new Elysia({ prefix: "/api/rsvp" })
    // Gate every method under /api/rsvp behind a valid session cookie.
    .use(sessionAuth(db))
    .post(
      "/",
      async ({ request, familyId, set }) => {
        // The sessionAuth plugin guarantees this is set; the assertion below
        // is a runtime safety net.
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

        const contentLengthHeader = request.headers.get("content-length");
        if (contentLengthHeader) {
          const declared = Number.parseInt(contentLengthHeader, 10);
          if (Number.isFinite(declared) && declared > MAX_RSVP_BYTES) {
            set.status = 413;
            return { error: "Payload too large" };
          }
        }

        const raw: unknown = await request.json().catch(() => null);

        // Turnstile bot gate (key-optional; no-op when unconfigured). The
        // session cookie already authenticated the household above; this is the
        // anti-automation layer on the spam-prone RSVP write surface.
        const tsErr = await turnstileGate(turnstileVerifier, "rsvp", raw, request.headers);
        if (tsErr) {
          set.status = tsErr.status;
          return { error: tsErr.error };
        }

        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(BulkRsvpBody)(raw);

            const dbService = yield* DbService;

            // P-W1: the deadline join and the guest/invitation join are both
            // keyed ONLY on the authenticated familyId, both are reads, and
            // neither result is returned to the caller before the gates below
            // run — so it's safe to fire them concurrently instead of paying
            // for two serialised round-trips. `Effect.all` is sequential by
            // default; the concurrency option is what actually parallelises
            // this. The trade: the guest/invitation read now runs even on a
            // request a later gate rejects (host preview, closed deadline),
            // where it used to be skipped. One extra index-served read on the
            // reject path buys one fewer round-trip on every accept path. Both sides are already index-served: guests_family_id_sort_idx
            // covers the family/guest join's WHERE, and guest_events' primary key
            // (guest_id, event_id) covers the LEFT JOIN probe.
            const [[family], familyGuestEvents] = yield* Effect.all(
              [
                // The household's own row plus its wedding's RSVP deadline — one
                // join rather than two round-trips, since both gates below run on
                // every submit. The FK guarantees the wedding row exists, so an
                // inner join can only miss if the family itself is gone.
                dbQuery(() =>
                  dbService
                    .select({
                      kind: families.kind,
                      rsvpDeadline: weddings.rsvpDeadline,
                      rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
                    })
                    .from(families)
                    .innerJoin(weddings, eq(weddings.id, families.weddingId))
                    .where(eq(families.id, familyId))
                    .all(),
                ),
                // Every guest owned by this family, LEFT JOINed to their event
                // invitations (a guest with zero guest_events rows still belongs
                // to the family — the join must not drop them). This is read 2
                // and read 3 from before folded into one query; ownership and
                // invitation sets are both derived from it below. Deliberately
                // keyed on familyId alone, never on body-supplied guest/event
                // ids — those are only validated AFTER ownership is established.
                dbQuery(() =>
                  dbService
                    .select({ guestId: guests.id, eventId: guestEvents.eventId })
                    .from(guests)
                    .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
                    .where(eq(guests.familyId, familyId))
                    .all(),
                ),
              ],
              { concurrency: "unbounded" },
            );

            // Fail CLOSED on a missing row (S-L1). Both gates below read this
            // result, so an optional-chained `family?.…` would make a zero-row
            // join answer "allow" to each of them — the host-preview write ban
            // and the deadline would both vanish. The FK cascade means a family
            // can't outlive its wedding today, but a deny decision must not
            // depend on that staying true.
            if (!family) {
              set.status = 403;
              return { error: "Unauthorized" };
            }

            // The host preview family is read-only — its code unlocks every
            // event for the organiser, but it must never write real RSVP data.
            if (family.kind === "host") {
              set.status = 403;
              yield* Effect.sync(() => metricRsvpBlocked("preview"));
              return { error: "Preview sessions cannot submit RSVPs" };
            }

            // The RSVP deadline is enforced HERE, on the write, not just in the
            // guest UI: the invite renders read-only past it, but a stale tab
            // (or anything talking to the API directly) must not be able to
            // slip a late reply in. The organiser's own recording endpoint is
            // deliberately NOT gated — a phone/paper RSVP arriving after the
            // date is exactly the case they need to enter. A wedding with no
            // deadline set never closes.
            if (isRsvpClosed(family.rsvpDeadline, family.rsvpDeadlineTimezone, new Date())) {
              set.status = 403;
              yield* Effect.sync(() => metricRsvpBlocked("deadline"));
              // A machine-readable code, not prose: the guest site maps it to
              // its own "RSVPs closed" copy, which names the date.
              return { error: "rsvp_closed" };
            }

            // Guest IDs that belong to the session's family — every distinct
            // guestId in the joined rows, including rows whose eventId is null
            // (a guest with no invitations still belongs to the family).
            const familyGuestIds = new Set(familyGuestEvents.map((row) => row.guestId));

            // Validate every requested guestId is owned by the session's family.
            for (const rsvp of body.rsvps) {
              if (!familyGuestIds.has(rsvp.guestId)) {
                set.status = 403;
                return { error: "One or more guests do not belong to this family" };
              }
            }

            // S-M1: every (guestId, eventId) pair must correspond to a real
            // invitation. Without this a guest could RSVP to an event they aren't
            // invited to — including another wedding's event if they learn its UUID.
            // Derived from the same LEFT JOIN as the ownership set above; a null
            // eventId (no invitation) must never enter this set.
            const invitedSet = new Set(
              familyGuestEvents
                .filter((row) => row.eventId !== null)
                .map((row) => `${row.guestId}::${row.eventId}`),
            );
            for (const rsvp of body.rsvps) {
              if (!invitedSet.has(`${rsvp.guestId}::${rsvp.eventId}`)) {
                set.status = 403;
                return { error: "One or more guests are not invited to that event" };
              }
            }

            // Art. 9(2)(a) gate: the special-category `dietary` free-text may
            // only be collected with the guest's explicit opt-in. Reject the
            // whole batch (422) if any non-empty dietary lacks consent — the
            // form blocks this, so reaching here means a tampered/legacy client.
            // See [[wiki/compliance/dpia/cire-guest-data]] → C-H2.
            for (const rsvp of body.rsvps) {
              if (rsvp.dietary.length > 0 && !rsvp.dietaryConsent) {
                set.status = 422;
                return { error: "Dietary requirements need your consent to store" };
              }
            }

            // Ownership + invitation already validated above — service method does
            // not re-check. Upsert the whole batch AND read back the family's
            // current rows in ONE D1 round-trip (P-W1) instead of two.
            const updatedRsvps = yield* rsvpService.submitRsvpsAndList(
              body.rsvps.map((rsvp) => ({
                guestId: rsvp.guestId,
                eventId: rsvp.eventId,
                status: rsvp.status,
                dietary: rsvp.dietary,
                // Only stamp a consent record when there is special-category
                // data to authorise; clearing dietary clears the record too.
                dietaryConsent: rsvp.dietary.length > 0 && rsvp.dietaryConsent,
              })),
              familyId,
            );

            yield* Effect.sync(() => metricRsvpBatchSize(body.rsvps.length));

            return { rsvps: updatedRsvps };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("ParseError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
          ),
        );
      },
      // Sentinel parse hook: stops Elysia from consuming the body so the
      // handler can parse it by hand — a malformed payload degrades to the
      // schema's 400 instead of Elysia's parser error.
      { parse: () => ({}) },
    );
