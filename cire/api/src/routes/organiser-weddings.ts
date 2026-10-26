import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import type { HTTPHeaders } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { EffectDbService, type EffectD1Db } from "../db/effect-handle";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware, rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { CreateWeddingBody, RemintBody } from "../schemas/wedding";
import { claimService } from "../services/claim";
import { familyDeactivateService } from "../services/family-deactivate";
import { giftExportService } from "../services/gift-export";
import { hostCodeService } from "../services/host-code";
import { markSharedService } from "../services/mark-shared";
import { planningExportService } from "../services/planning-export";
import { regenerateCodeService } from "../services/regenerate-code";
import { remintCodesService } from "../services/remint-codes";
import { rsvpExportService, toCsv } from "../services/rsvp-export";
import { seatingExportService } from "../services/seating-export";
import { downloadFidelity, stateExportService } from "../services/state-export";
import { tableExportService } from "../services/table-export";
import { legacyEntitlementKeys, tierService } from "../services/tiers";
import { weddingsService } from "../services/weddings";

// Sentinel parse hook: stops Elysia from consuming the body so the handler can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error. Same idiom as the import routes.
const manualParse = { parse: () => ({}) };

/**
 * Wrap a server-built CSV in a browser-download response. Shared by every export
 * below: Content-Disposition: attachment so the browser downloads it directly;
 * guest PII (names, dietary, codes) and the couple's own figures — never let
 * an intermediary cache them; nosniff as belt-and-braces against content sniffing.
 */
const csvAttachment = (csv: string, filename: string) =>
  new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/**
 * Shared defect recovery for the CSV export routes: log the failure (a silent
 * run of 500s on a PII-bearing export leaves no incident signal; weddingId
 * only, never guest data) and answer a generic 500.
 */
const exportDefect = (set: { status?: number | string }, exportName: string, weddingId: string) =>
  Effect.gen(function* () {
    yield* Effect.logError("csv export failed", { export: exportName, weddingId });
    set.status = 500;
    return { error: "Internal error" };
  });

/**
 * Runs an export read on the D1 Effect handle. An app built without one dies
 * here, so the route answers through its own `catchDefect`.
 */
const onEffectDb = <A>(
  effectDb: EffectD1Db | undefined,
  read: Effect.Effect<A, never, EffectDbService>,
): Effect.Effect<A> =>
  effectDb === undefined
    ? Effect.die(new Error("organiser export: no EffectDbService was provided"))
    : read.pipe(Effect.provideService(EffectDbService, effectDb));

/**
 * The same treatment for the JSON roster reads (`/guests`, `/households`), which
 * carry the identical payload class — household claim codes and guest names — in
 * a different envelope. Two consequences follow from that, and both were missing
 * until the guest editor started depending on these reads for delete-correctness:
 * a failure has to leave an incident signal (weddingId only, never row data), and
 * the response has to be marked uncacheable. `families.public_id` is classified a
 * CREDENTIAL in the compliance data map, and a response with no freshness
 * directive is heuristically cacheable by anything on the path.
 */
const rosterDefect = (set: { status?: number | string }, read: string, weddingId: string) =>
  Effect.gen(function* () {
    yield* Effect.logError("organiser roster read failed", { read, weddingId });
    set.status = 500;
    return { error: "Internal error" };
  });

/**
 * Mark a roster read uncacheable. `/guests` and `/households` carry claim codes
 * (see {@link rosterDefect}); all three reads, `/events` included, seed an
 * editor draft that must be no older than the change head the editor read just
 * before them, which a cached copy could be.
 */
const noStore = (set: { headers: HTTPHeaders }) => {
  set.headers["cache-control"] = "no-store";
};

/**
 * Wedding-scoped organiser routes, mounted under /api/organiser. osnAuth()
 * gates every route in this instance (osnProfileId resolved on every request).
 *
 * The per-wedding subtree splits by authorisation level (roles matrix,
 * platform-plan §3.5):
 *  - DASHBOARD READS (`/guests`, `/events`) use `weddingMember()` — owner OR
 *    any co-host (editor AND viewer). Co-hosts get the read dashboard, nothing
 *    destructive. The CSV exports (owners only) + `/rsvps` view are in a
 *    sibling instance (`createOrganiserExportRoutes`) behind a per-user
 *    limiter.
 *  - CODE MANAGEMENT (`regenerate-code`, family deactivate/reactivate) uses
 *    `weddingOwner()` — claim codes are the guest credential, so cutting one
 *    off or rotating it is owner-only.
 */
export const createOrganiserWeddingsRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .get("/weddings", ({ osnProfileId, set }) => {
      if (!osnProfileId) {
        set.status = 401;
        return { error: "unauthorised" };
      }
      return runCire(
        Effect.gen(function* () {
          const list = yield* weddingsService.listForMember(osnProfileId);
          // Entitlement keys matter only to a wedding that can be opened.
          const premium = yield* tierService.premiumTemplateHolders(list.weddings.map((w) => w.id));
          for (const w of list.weddings) {
            w.entitlements = legacyEntitlementKeys(w.tier, premium.has(w.id));
          }
          return {
            weddings: list.weddings,
            // An owner's soft-deleted weddings they can still restore.
            deleted: list.deleted.map((w) => ({
              id: w.id,
              slug: w.slug,
              displayName: w.displayName,
              deletedAt: w.deletedAt.toISOString(),
              restoreUntil: w.restoreUntil.toISOString(),
            })),
          };
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchDefect(() =>
            Effect.sync(() => {
              set.status = 500;
              return { error: "Internal error" };
            }),
          ),
        ),
      );
    })
    // Dashboard reads — owner OR co-host (weddingMember).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .get("/guests", ({ weddingId, set }) => {
          // weddingMember() always resolves this; the guard keeps a future
          // remount without the plugin from compiling into an unscoped query.
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          noStore(set);
          return runCire(
            claimService.getAllGuests(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => rosterDefect(set, "guests", weddingId)),
            ),
          );
        })
        // Household-shaped companion to `/guests`: one row per family, INCLUDING
        // families that currently hold no guests (which the guest-shaped read
        // cannot represent). The guest editor loads it so a code-only household
        // survives a draft save instead of reading as a deletion.
        .get("/households", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          noStore(set);
          return runCire(
            claimService.getAllHouseholds(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => rosterDefect(set, "households", weddingId)),
            ),
          );
        })
        .get("/events", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId || !weddingSlug) {
            set.status = 500;
            return { error: "Internal error" };
          }
          noStore(set);
          return runCire(
            claimService.listEvents(weddingId, weddingSlug).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    )
    // Code management — owner only (weddingOwner): claim codes are the guest
    // credential, so anything that mints, rotates, or cuts one off is the
    // owner's call (roles matrix, platform-plan §3.5).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        // Cut off a withdrawn invite: deactivate a family so its claim code stops
        // working (the guest claim path rejects it like an unknown code), WITHOUT
        // deleting the family/guests/RSVPs. Reversible via `.../reactivate`.
        // The service re-checks family ∈
        // wedding AND kind='guest', so a host-preview family can't be deactivated
        // and an owner of wedding A can't touch wedding B's family.
        .post("/families/:familyId/deactivate", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            familyDeactivateService.setDeactivated(weddingId, params.familyId, true).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, deactivatedAt: r.deactivatedAt })),
              Effect.catchTags({
                FamilyNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "family_not_found" };
                  }),
                DeactivateWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not deactivate family" };
                  }),
              }),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        // Restore a deactivated family: clear the marker so its code claims again
        // (the data was never deleted). Same weddingOwner() gate + cross-tenant /
        // kind guard as deactivate.
        .post("/families/:familyId/reactivate", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            familyDeactivateService.setDeactivated(weddingId, params.familyId, false).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, deactivatedAt: r.deactivatedAt })),
              Effect.catchTags({
                FamilyNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "family_not_found" };
                  }),
                DeactivateWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not reactivate family" };
                  }),
              }),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    )
    // Destructive — owner only (weddingOwner).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        // Rotate a family's claim code + revoke its sessions, atomically.
        // weddingOwner() already proved the caller owns :weddingId; the service
        // re-checks family ∈ wedding (404 FamilyNotInWedding otherwise) so an
        // owner of wedding A can't rotate a family under wedding B.
        .post("/families/:familyId/regenerate-code", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            regenerateCodeService.regenerate(weddingId, params.familyId).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, publicId: r.publicId })),
              Effect.catchTags({
                FamilyNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "family_not_found" };
                  }),
                RegenerateWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not regenerate code" };
                  }),
              }),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );

/**
 * CSV + JSON RSVP export routes, split into their own instance so the per-user
 * rate limiter gates only the export reads and not the dashboard's `/guests` +
 * `/events` reads above. A caller can trigger these reads in a loop and burn D1
 * read quota / Worker CPU on the Free tier — a modest per-user cap (~10/min)
 * bounds the amplifier while remaining transparent to normal hand-use. Same
 * sibling-instance pattern as the preview + remint routes.
 *
 * Two gates. Every CSV download is `weddingOwner()`: a file leaves the portal
 * and goes wherever its holder sends it, so taking the wedding's data away is
 * an owner's call, and editors and viewers read it on screen instead. The row
 * counts behind the budget, checklist, gift and seating downloads
 * (`/module-rows`) sit with them. The dashboard's RSVP view (`/rsvps`) is a screen read, so it stays
 * `weddingMember()`.
 *
 * The gift-log download is not here: it has an instance of its own
 * ({@link createOrganiserGiftExportRoutes}), where a tighter limiter answers
 * before this group's shared one. Its row count stays in `/module-rows`.
 *
 * The per-user limiter keys on `osnProfileId` (not the client IP): the caller
 * is already authenticated and wedding-scoped, so keying on their identity
 * rather than their edge IP is both more accurate (one person per bucket) and
 * consistent with the per-user limiters of sibling services.
 */
export const createOrganiserExportRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  effectDb: EffectD1Db | undefined,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    // The CSV downloads — owners only.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(limiter))
        // RSVP CSV export — one row per guest (incl. guests who haven't RSVP'd),
        // then a status/dietary PAIR per event (dietary is stored per
        // (guest, event), so one aggregate column had to drop answers). Sorted
        // by family code. The filename embeds the wedding slug, which the owner
        // gate reads with the caller's seat.
        .get("/rsvps.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const data = yield* onEffectDb(effectDb, rsvpExportService.build(weddingId));
              return csvAttachment(toCsv(data), `cire-rsvps-${weddingSlug ?? weddingId}.csv`);
            }).pipe(Effect.catchDefect(() => exportDefect(set, "rsvps.csv", weddingId))),
          );
        })
        // Guest-roster CSV export — one row per guest with household code,
        // invited event names, Sent/Opened timestamps, and code status. Same
        // owner gate + attachment/no-store contract as rsvps.csv.
        .get("/guests.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* onEffectDb(effectDb, tableExportService.guestsCsv(weddingId));
              return csvAttachment(csv, `cire-guests-${weddingSlug ?? weddingId}.csv`);
            }).pipe(Effect.catchDefect(() => exportDefect(set, "guests.csv", weddingId))),
          );
        })
        // Event-list CSV export — one row per event (chronological) with the
        // dashboard's details plus an invited-guest count. Same owner gate +
        // attachment/no-store contract as rsvps.csv.
        .get("/events.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* onEffectDb(effectDb, tableExportService.eventsCsv(weddingId));
              return csvAttachment(csv, `cire-events-${weddingSlug ?? weddingId}.csv`);
            }).pipe(Effect.catchDefect(() => exportDefect(set, "events.csv", weddingId))),
          );
        })
        // The budget and checklist exports — the couple's budget lines (each
        // followed by its payments) and their tasks, in the portal's order.
        // Same owner gate + attachment/no-store contract as the exports above.
        //
        // No `weddingTier(db, "gold")` gate, though both modules are Gold,
        // reads included, for the reason `gifts.csv` has none: these are rows
        // the couple entered, a wedding keeps them when its tier no longer
        // opens the module, and refusing to hand back data we hold is the
        // worse failure. Each file is capped (`MAX_PLANNING_EXPORT_ROWS`) and
        // the group is rate-limited.
        .get("/budget.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* planningExportService.budgetCsv(weddingId);
              return csvAttachment(csv, `cire-budget-${weddingSlug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => exportDefect(set, "budget.csv", weddingId)),
            ),
          );
        })
        .get("/tasks.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* planningExportService.tasksCsv(weddingId);
              return csvAttachment(csv, `cire-tasks-${weddingSlug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => exportDefect(set, "tasks.csv", weddingId)),
            ),
          );
        })
        // The seating chart for the venue — every guest seated in each
        // event's selected plan, by event and table order. Ungated for the
        // reason the budget and checklist files are: a wedding below the
        // seating module's tier keeps its chart and takes it back from the
        // locked card. Capped
        // (`MAX_SEATING_EXPORT_ROWS`) and rate-limited with the group.
        .get("/seating.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* onEffectDb(effectDb, seatingExportService.seatingCsv(weddingId));
              return csvAttachment(csv, `cire-seating-${weddingSlug ?? weddingId}.csv`);
            }).pipe(Effect.catchDefect(() => exportDefect(set, "seating.csv", weddingId))),
          );
        })
        // How many rows `budget.csv`, `tasks.csv`, `gifts.csv` and
        // `seating.csv` would carry. The portal asks when an owner opens a
        // locked Budget, Checklist, Registry or Seating card, and offers that
        // module's file only when there is something in it. Owner only, like
        // the files it describes, and ungated for the same reason.
        .get("/module-rows", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          noStore(set);
          return runCire(
            planningExportService.moduleRows(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() =>
                Effect.gen(function* () {
                  yield* Effect.logError("module rows read failed", { weddingId });
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        // Round-trip exports — the wedding's CURRENT events/guests serialised
        // in the IMPORT template schema, so the download can be edited in a
        // spreadsheet tool and re-uploaded through the import (unlike the
        // reporting exports above). `?fidelity=full` appends the snapshot
        // ID/code columns (the parser ignores them today; E2 honours them) —
        // and therefore contains live claim codes. Same owner gate +
        // attachment/no-store contract as the reporting exports.
        .get("/export/events.csv", ({ weddingId, weddingSlug, query, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const fidelity = downloadFidelity(query.fidelity);
          return runCire(
            Effect.gen(function* () {
              const csv = yield* stateExportService.downloadEventsCsv(weddingId, fidelity);
              return csvAttachment(csv, `cire-export-events-${weddingSlug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => exportDefect(set, "export/events.csv", weddingId)),
            ),
          );
        })
        .get("/export/guests.csv", ({ weddingId, weddingSlug, query, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const fidelity = downloadFidelity(query.fidelity);
          return runCire(
            Effect.gen(function* () {
              const csv = yield* stateExportService.downloadGuestsCsv(weddingId, fidelity);
              return csvAttachment(csv, `cire-export-guests-${weddingSlug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => exportDefect(set, "export/guests.csv", weddingId)),
            ),
          );
        }),
    )
    // The dashboard's RSVP view — every member. A second `.group` on the same
    // path, because a gate is applied per group.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(rateLimitMiddlewareByUser(limiter))
        // Read-only in-dashboard RSVP view — the same wedding-scoped, host-
        // excluded RSVP data as the CSV export, shaped BY EVENT (each event with
        // its responded guests + a status tally) for the dashboard's RSVPs tab.
        // Same weddingMember() gate as the reads above (owner OR co-host). PII
        // (names, dietary) — never let an intermediary cache it.
        .get("/rsvps", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const view = yield* onEffectDb(effectDb, rsvpExportService.buildView(weddingId));
              set.headers["cache-control"] = "no-store";
              return view;
            }).pipe(Effect.catchDefect(() => exportDefect(set, "rsvps", weddingId))),
          );
        }),
    );

/**
 * The gift-log CSV export, in an instance of its own so it answers to a
 * tighter per-user limiter of its own as well as the shared export one above.
 * It is the heaviest export — the read runs to `MAX_GIFT_EXPORT_ROWS` + 1 rows
 * and the whole file is serialised close to the Worker's CPU ceiling.
 *
 * The gift limiter answers first, so a gift download it refuses spends nothing
 * from the shared allowance; one it admits spends one of each. An owner's
 * exports therefore stay within the shared limit in all, and at most the gift
 * limit of them are gift downloads. Same gates in the same order as the other
 * CSV downloads: `osnAuth()`, then `weddingOwner()`, then the per-user limiters,
 * both keyed on `osnProfileId`.
 */
export const createOrganiserGiftExportRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  giftLimiter: RateLimiterBackend,
  exportLimiter: RateLimiterBackend,
  effectDb: EffectD1Db | undefined,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(giftLimiter))
        .use(rateLimitMiddlewareByUser(exportLimiter))
        // One row per gift, claims and cash together, newest first: the same
        // log the registry tab pages through, whole. This is the couple's copy
        // of a record we delete a year after the wedding, so it carries the
        // detail the year-end summary cannot: who gave what, in which
        // currency, and what they wrote. Same owner gate +
        // attachment/no-store contract as the other exports.
        //
        // No `weddingTier(db, "gold")` gate, unlike every other registry
        // surface, and that is deliberate: the log is the couple's own
        // record, and they must be able to take it away whether or not the
        // wedding is still on Gold. Refusing to hand back data we hold is the
        // worse failure. A wedding that was never on Gold has no gifts, so it
        // gets the header line and nothing else; the read
        // is capped and rate-limited. A gate here would have to keep admitting
        // this read for as long as the gift rows exist, so it cannot be the
        // plain one the registry routes use.
        .get("/gifts.csv", ({ weddingId, weddingSlug, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const csv = yield* onEffectDb(effectDb, giftExportService.giftsCsv(weddingId));
              return csvAttachment(csv, `cire-gifts-${weddingSlug ?? weddingId}.csv`);
            }).pipe(Effect.catchDefect(() => exportDefect(set, "gifts.csv", weddingId))),
          );
        }),
    );

/**
 * Create a new wedding owned by the caller, split into its own instance so the
 * per-IP rate limiter gates only this mutating insert and not the
 * `GET /weddings` list above. The limiter answers before osnAuth(), so a
 * refused request costs no session lookup or token verify. osnAuth() supplies
 * the owner — the body carries only the display name (slug + id are
 * server-generated). Same sibling-instance pattern as the preview +
 * account-link POSTs.
 */
export const createOrganiserWeddingCreateRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .post(
      "/weddings",
      async ({ osnProfileId, request, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }

        const raw: unknown = await request.json().catch(() => null);

        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknownEffect(CreateWeddingBody)(raw);
            const wedding = yield* weddingsService.createForOwner(
              osnProfileId,
              body.displayName,
              body.codeStyle,
            );
            set.status = 201;
            return { wedding };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("SchemaError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
            Effect.catchTag("WeddingCreateError", () =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Could not create wedding" };
              }),
            ),
            Effect.catchDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      },
      manualParse,
    );

/**
 * Host preview-code provisioning, split into its own instance so the per-IP
 * rate limiter gates only this mutating route (the find-or-create + event-relink
 * amplifier) and not the dashboard's read endpoints above. Gated
 * osnAuth + weddingMember (any role): previewing the invite is the read
 * experience — it's the only way a co-host, including a read-only viewer, sees
 * the invite as a guest would — and the minted code is the wedding's synthetic
 * host-preview family (idempotent find-or-create, blocked from submitting
 * RSVPs), not a guest credential, so the owner-only code-management rule
 * doesn't apply. The organiser dashboard opens the guest invite with
 * `?code=<publicId>` so the host sees every event. The limiter answers before
 * osnAuth() and the member gate, so a refused request costs no session lookup,
 * token verify or gate query.
 */
export const createOrganiserPreviewRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).post("/preview-code", ({ weddingId, weddingSlug, set }) => {
        if (!weddingId || !weddingSlug) {
          set.status = 500;
          return { error: "Internal error" };
        }
        return runCire(
          hostCodeService.ensureForWedding(weddingId, weddingSlug).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("HostCodeError", () =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
            Effect.catchDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      }),
    );

/**
 * Bulk claim-code re-mint onto a new style + per-family "mark shared" (the
 * Copy-message button), split into their own instance behind a per-IP limiter
 * so the destructive bulk-write + the high-frequency mark-shared writes don't
 * sit behind (or gate) the dashboard reads. Same sibling-instance pattern as
 * the preview + create routes.
 *
 * Two gates. Re-minting rotates every guest's credential, so it is
 * `weddingOwner()`. Marking a code shared is bookkeeping for whoever copied the
 * message — it records that a code went out, and changes no credential — so
 * it is `weddingEditor()`: an editor who sends the invites gets them counted.
 *
 * One limiter, mounted ahead of osnAuth() and both gates, so a refused request
 * costs no session lookup, token verify or gate query.
 */
export const createOrganiserRemintRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        // Flip the wedding's code style + rotate EVERY guest family's code
        // onto it, clearing each family's shared marker + revoking its sessions,
        // atomically. Destructive: any already-shared code is invalidated.
        // weddingOwner() proved ownership; the service only touches rows scoped
        // to :weddingId.
        .post(
          "/remint",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(RemintBody)(raw);
                return yield* remintCodesService.remint(weddingId, body.codeStyle);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.map((r) => ({ codeStyle: r.codeStyle, reminted: r.reminted })),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "wedding_not_found" };
                  }),
                ),
                Effect.catchTag("RemintWriteError", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not re-mint codes" };
                  }),
                ),
                Effect.catchDefect(() =>
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
    )
    // MARK SHARED — owner or editor. A second `.group` on the same path,
    // because a gate is applied per group.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        // Mark a family's invite code as "shared" — best-effort, fired by the
        // Copy-message button. Bodiless. 404 if the family isn't in :weddingId.
        .post("/families/:familyId/mark-shared", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            markSharedService.markShared(weddingId, params.familyId).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, codeSharedAt: r.codeSharedAt })),
              Effect.catchTag("FamilyNotInWedding", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "family_not_found" };
                }),
              ),
              Effect.catchTag("MarkSharedWriteError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Could not mark shared" };
                }),
              ),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
