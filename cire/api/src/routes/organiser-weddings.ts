import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware, rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { CreateWeddingBody, RemintBody } from "../schemas/wedding";
import { claimService } from "../services/claim";
import { entitlementService } from "../services/entitlements";
import { familyDeactivateService } from "../services/family-deactivate";
import { hostCodeService } from "../services/host-code";
import { markSharedService } from "../services/mark-shared";
import { regenerateCodeService } from "../services/regenerate-code";
import { remintCodesService } from "../services/remint-codes";
import { rsvpExportService, toCsv } from "../services/rsvp-export";
import { stateExportService } from "../services/state-export";
import { tableExportService } from "../services/table-export";
import { weddingsService } from "../services/weddings";

// Sentinel parse hook: stops Elysia from consuming the body so the handler can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error. Same idiom as the import routes.
const manualParse = { parse: () => ({}) };

/**
 * Wrap a server-built CSV in a browser-download response. Shared by the three
 * exports (rsvps / guests / events): Content-Disposition: attachment so the
 * browser downloads it directly; guest PII (names, dietary, codes) — never let
 * an intermediary cache it; nosniff as belt-and-braces against content sniffing.
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
 * Shared defect recovery for the CSV export routes: log the failure (S-L2 —
 * a silent run of 500s on a PII-bearing export leaves no incident signal;
 * weddingId only, never guest data) and answer a generic 500.
 */
const exportDefect = (set: { status?: number | string }, exportName: string, weddingId: string) =>
  Effect.gen(function* () {
    yield* Effect.logError("csv export failed", { export: exportName, weddingId });
    set.status = 500;
    return { error: "Internal error" };
  });

/**
 * Wedding-scoped organiser routes, mounted under /api/organiser. osnAuth()
 * gates every route in this instance (osnProfileId derived on every request).
 *
 * The per-wedding subtree splits by authorisation level (roles matrix,
 * platform-plan §3.5):
 *  - DASHBOARD READS (`/guests`, `/events`) use `weddingMember()` — owner OR
 *    any co-host (editor AND viewer). Co-hosts get the read dashboard, nothing
 *    destructive. The CSV exports + `/rsvps` view are in a sibling instance
 *    (`createOrganiserExportRoutes`) behind a per-user limiter (CSV-S-L1).
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
          const sets = yield* entitlementService.setsForWeddings(list.map((w) => w.id));
          return {
            weddings: list.map((w) => {
              const keys = sets.get(w.id) ?? [];
              return {
                ...w,
                entitlements: keys,
                guestCap: entitlementService.deriveCap(keys),
              };
            }),
          };
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchAllDefect(() =>
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
          // weddingMember() always derives this; the guard keeps a future
          // remount without the plugin from compiling into an unscoped query.
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            claimService.getAllGuests(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        .get("/events", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            claimService.listEvents(weddingId).pipe(
              Effect.provideService(DbService, db),
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
              Effect.catchAllDefect(() =>
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
    // Destructive — owner only (weddingOwner).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        // C2: rotate a family's claim code + revoke its sessions, atomically.
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
              Effect.catchAllDefect(() =>
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
 * rate limiter (CSV-S-L1) gates only the export reads and not the dashboard's
 * `/guests` + `/events` reads above. Any authenticated organiser can trigger
 * these reads in a loop and burn D1 read quota / Worker CPU on the Free tier —
 * a modest per-user cap (~10/min) bounds the amplifier while remaining
 * transparent to normal hand-use. Same sibling-instance pattern as the preview
 * + remint routes; same weddingMember() gate (owner OR co-host).
 *
 * The per-user limiter keys on `osnProfileId` (not the client IP): the caller
 * is already authenticated and wedding-scoped, so keying on their identity
 * rather than their edge IP is both more accurate (one person per bucket) and
 * consistent with the Upstash per-user backend used by sibling services.
 */
export const createOrganiserExportRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(rateLimitMiddlewareByUser(limiter))
        // RSVP CSV export — one row per guest (incl. guests who haven't RSVP'd),
        // one column per event, dietary requirements. Sorted by family code.
        // Same weddingMember() gate as the reads above (owner OR co-host). The
        // filename embeds the wedding slug.
        .get("/rsvps.csv", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              // The build and the filename slug are independent reads — run
              // them concurrently rather than paying two sequential D1
              // round-trips (P-I1).
              const [data, slug] = yield* Effect.all(
                [rsvpExportService.build(weddingId), weddingsService.slugOf(weddingId)],
                { concurrency: 2 },
              );
              return csvAttachment(toCsv(data), `cire-rsvps-${slug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() => exportDefect(set, "rsvps.csv", weddingId)),
            ),
          );
        })
        // Guest-roster CSV export — one row per guest with household code,
        // invited event names, Sent/Opened timestamps, and code status. Same
        // weddingMember() gate + attachment/no-store contract as rsvps.csv.
        .get("/guests.csv", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const [csv, slug] = yield* Effect.all(
                [tableExportService.guestsCsv(weddingId), weddingsService.slugOf(weddingId)],
                { concurrency: 2 },
              );
              return csvAttachment(csv, `cire-guests-${slug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() => exportDefect(set, "guests.csv", weddingId)),
            ),
          );
        })
        // Event-list CSV export — one row per event (chronological) with the
        // dashboard's details plus an invited-guest count. Same weddingMember()
        // gate + attachment/no-store contract as rsvps.csv.
        .get("/events.csv", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const [csv, slug] = yield* Effect.all(
                [tableExportService.eventsCsv(weddingId), weddingsService.slugOf(weddingId)],
                { concurrency: 2 },
              );
              return csvAttachment(csv, `cire-events-${slug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() => exportDefect(set, "events.csv", weddingId)),
            ),
          );
        })
        // Round-trip exports — the wedding's CURRENT events/guests serialised
        // in the IMPORT template schema, so the download can be edited in a
        // spreadsheet tool and re-uploaded through the import (unlike the
        // reporting exports above). `?fidelity=full` appends the snapshot
        // ID/code columns (the parser ignores them today; E2 honours them) —
        // and therefore contains live claim codes. Same weddingMember() gate +
        // attachment/no-store contract as the reporting exports.
        .get("/export/events.csv", ({ weddingId, query, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const fidelity = query.fidelity === "full" ? "full" : "import";
          return runCire(
            Effect.gen(function* () {
              const [csv, slug] = yield* Effect.all(
                [
                  stateExportService.eventsCsv(weddingId, fidelity),
                  weddingsService.slugOf(weddingId),
                ],
                { concurrency: 2 },
              );
              return csvAttachment(csv, `cire-export-events-${slug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() => exportDefect(set, "export/events.csv", weddingId)),
            ),
          );
        })
        .get("/export/guests.csv", ({ weddingId, query, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const fidelity = query.fidelity === "full" ? "full" : "import";
          return runCire(
            Effect.gen(function* () {
              const [csv, slug] = yield* Effect.all(
                [
                  stateExportService.guestsCsv(weddingId, fidelity),
                  weddingsService.slugOf(weddingId),
                ],
                { concurrency: 2 },
              );
              return csvAttachment(csv, `cire-export-guests-${slug ?? weddingId}.csv`);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() => exportDefect(set, "export/guests.csv", weddingId)),
            ),
          );
        })
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
            rsvpExportService.buildView(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.tap(() =>
                Effect.sync(() => {
                  set.headers["cache-control"] = "no-store";
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
    );

/**
 * Create a new wedding owned by the caller, split into its own instance so the
 * per-IP rate limiter (S-L1) gates only this mutating insert and not the
 * `GET /weddings` list above. osnAuth() supplies the owner — the body carries
 * only the display name (slug + id are server-generated). Same sibling-instance
 * pattern as the preview + account-link POSTs.
 */
export const createOrganiserWeddingCreateRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .use(rateLimitMiddleware(limiter))
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
            const body = yield* Schema.decodeUnknown(CreateWeddingBody)(raw);
            const wedding = yield* weddingsService.createForOwner(
              osnProfileId,
              body.displayName,
              body.codeStyle,
            );
            set.status = 201;
            return { wedding };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("ParseError", () =>
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
    );

/**
 * Host preview-code provisioning, split into its own instance so the per-IP
 * rate limiter gates only this mutating route (the find-or-create + event-relink
 * amplifier — S-M2) and not the dashboard's read endpoints above. Gated
 * osnAuth + weddingMember (any role): previewing the invite is the read
 * experience — it's the only way a co-host, including a read-only viewer, sees
 * the invite as a guest would — and the minted code is the wedding's synthetic
 * host-preview family (idempotent find-or-create, blocked from submitting
 * RSVPs), not a guest credential, so the owner-only code-management rule
 * doesn't apply. The organiser dashboard opens the guest invite with
 * `?code=<publicId>` so the host sees every event.
 */
export const createOrganiserPreviewRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(rateLimitMiddleware(limiter))
        .post("/preview-code", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            hostCodeService.ensureForWedding(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("HostCodeError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
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
    );

/**
 * Bulk claim-code re-mint onto a new style (C3) + per-family "mark shared"
 * (the Copy-message button). Both are owner-only (weddingOwner) and split into
 * their own instance behind a per-IP limiter so the destructive bulk-write +
 * the high-frequency mark-shared writes don't sit behind (or gate) the
 * dashboard reads. Same sibling-instance pattern as the preview + create routes.
 */
export const createOrganiserRemintRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddleware(limiter))
        // C3: flip the wedding's code style + rotate EVERY guest family's code
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
                const body = yield* Schema.decodeUnknown(RemintBody)(raw);
                return yield* remintCodesService.remint(weddingId, body.codeStyle);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.map((r) => ({ codeStyle: r.codeStyle, reminted: r.reminted })),
                Effect.catchTag("ParseError", () =>
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
        )
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
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
