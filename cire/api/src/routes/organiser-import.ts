import { imports } from "@cire/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { ApplyBody, PreviewBody, RevertBody } from "../schemas/import";
import type { ImportPlan, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "../services/import";
import { R2Service, fetchUpload, storeUpload } from "../services/r2-imports";
import type { R2Bucket } from "../services/r2-imports";
import { revertImport } from "../services/revert";
import {
  parseEventsCsv,
  parseGuestsCsv,
  FormulaInjectionDetected,
  MissingRequiredColumn,
  UnmatchedEventColumn,
  MalformedSpreadsheet,
} from "../services/spreadsheet";

const ONE_MB = 1 * 1024 * 1024;

// Sentinel parse hook: stops Elysia from consuming the body so handlers can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error.
const manualParse = { parse: () => ({}) };

/**
 * Organiser import routes, mounted under
 * /api/organiser/weddings/:weddingId/import. osnAuth() gates every request and
 * weddingMember() proves the caller is the OWNER **or** a CO-HOST of the
 * :weddingId in the path (404 for unknown weddings, 403 for non-members),
 * deriving `weddingId`. Co-hosts are trusted co-organisers, so they get full
 * import access (preview / apply / revert / list) — the spreadsheet is the
 * primary way a wedding's guests + events are populated, and locking it to the
 * owner defeated co-hosting. The owner-only surface stays narrow: deleting the
 * wedding and managing the co-host list (see organiser-hosts / weddings routes).
 * Every import operation is scoped to that wedding — a member who organises
 * several weddings picks the target explicitly in the URL.
 *
 * `r2` mirrors the previous app-level optional binding: a deployment without
 * the SHEETS bucket fails at first use, not at startup.
 */
export const createOrganiserImportRoutes = (
  db: Db,
  r2: R2Bucket | undefined,
  osnAuthOptions: OsnAuthOptions,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId/import", (group) =>
      group
        .use(weddingMember(db))
        .post(
          "/preview",
          async ({ request, weddingId, set }) => {
            // weddingMember() always derives this; the guard keeps a future remount
            // without the plugin from compiling into an unscoped insert.
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }

            // Content-Length pre-check — reject obviously-oversized payloads BEFORE
            // we pay the cost of parsing JSON. We keep the post-parse byte check
            // below as a backup since some CDNs strip / lie about Content-Length.
            const contentLengthHeader = request.headers.get("content-length");
            if (contentLengthHeader) {
              const declared = Number.parseInt(contentLengthHeader, 10);
              if (Number.isFinite(declared) && declared > ONE_MB) {
                set.status = 413;
                return { error: "Payload too large" };
              }
            }

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(PreviewBody)(raw);

                const totalBytes =
                  new TextEncoder().encode(body.eventsCsv).length +
                  new TextEncoder().encode(body.guestsCsv).length;
                if (totalBytes > ONE_MB) {
                  set.status = 413;
                  return { error: "Upload too large (max 1MB total)" };
                }

                const importId = crypto.randomUUID();
                const { eventsKey, guestsKey } = yield* storeUpload(
                  body.eventsCsv,
                  body.guestsCsv,
                  importId,
                );

                const parsedEvents = yield* parseEventsCsv(body.eventsCsv);
                const parsedFamilies = yield* parseGuestsCsv(body.guestsCsv, parsedEvents);
                const plan: ImportPlan = yield* diffAgainstDb(
                  parsedEvents,
                  parsedFamilies as ParsedFamily[],
                  weddingId,
                );

                const dbService = yield* DbService;
                yield* dbQuery(() =>
                  dbService
                    .insert(imports)
                    .values({
                      id: importId,
                      // Scoped to the :weddingId in the path (weddingMember plugin).
                      weddingId,
                      uploadedAt: Date.now(),
                      format: "csv",
                      eventsR2Key: eventsKey,
                      guestsR2Key: guestsKey,
                      summary: JSON.stringify({
                        eventCreates: plan.eventCreates.length,
                        eventUpdates: plan.eventUpdates.length,
                        eventRemoves: plan.eventRemoves.length,
                        familyCreates: plan.familyCreates.length,
                        familyRemoves: plan.familyRemoves.length,
                        guestCreates: plan.guestCreates.length,
                        guestUpdates: plan.guestUpdates.length,
                        guestRemoves: plan.guestRemoves.length,
                      }),
                      status: "preview",
                    })
                    .run(),
                );

                yield* Effect.logInfo(
                  `import preview accepted: families=${parsedFamilies.length} guests=${parsedFamilies.reduce((n, f) => n + f.guests.length, 0)} events=${parsedEvents.length}`,
                  { importId },
                );

                return {
                  importId,
                  plan: {
                    ...plan,
                    // Force readonly arrays into plain arrays for JSON.
                    eventCreates: [...plan.eventCreates],
                    eventUpdates: [...plan.eventUpdates],
                    eventRemoves: [...plan.eventRemoves],
                    familyCreates: [...plan.familyCreates],
                    familyRemoves: [...plan.familyRemoves],
                    guestCreates: [...plan.guestCreates],
                    guestUpdates: [...plan.guestUpdates],
                    guestRemoves: [...plan.guestRemoves],
                    eventLinkCreates: [...plan.eventLinkCreates],
                    eventLinkRemoves: [...plan.eventLinkRemoves],
                    warnings: [...plan.warnings],
                  },
                  warnings: [...plan.warnings],
                };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.provideService(R2Service, r2 as R2Bucket),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("FormulaInjectionDetected", (e: FormulaInjectionDetected) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(`formula injection rejected`, {
                      row: e.row,
                      column: e.column,
                    });
                    // Surface coords but NOT contents. Snippet stays in logs only.
                    set.status = 422;
                    return {
                      error: "Formula-injection guard tripped",
                      row: e.row,
                      column: e.column,
                    };
                  }),
                ),
                Effect.catchTag("MissingRequiredColumn", (e: MissingRequiredColumn) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Missing required column", column: e.column };
                  }),
                ),
                Effect.catchTag("UnmatchedEventColumn", (e: UnmatchedEventColumn) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Unmatched event column", column: e.column };
                  }),
                ),
                Effect.catchTag("MalformedSpreadsheet", (e: MalformedSpreadsheet) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Malformed spreadsheet", reason: e.reason, row: e.row ?? null };
                  }),
                ),
                Effect.catchTag("R2Error", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Storage error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .post(
          "/apply",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const { importId } = yield* Schema.decodeUnknown(ApplyBody)(raw);
                const dbService = yield* DbService;

                const [row] = yield* dbQuery(() =>
                  dbService.select().from(imports).where(eq(imports.id, importId)).all(),
                );
                // A foreign wedding's import is indistinguishable from a missing one.
                if (!row || row.weddingId !== weddingId) {
                  set.status = 404;
                  return { error: "Import not found" };
                }
                if (row.status !== "preview") {
                  set.status = 409;
                  return { error: "Import is not in preview status" };
                }

                // Re-fetch CSV from R2 and re-diff (TOCTOU defence — DB may have shifted
                // since the preview snapshot).
                const eventsCsv = yield* fetchUpload(row.eventsR2Key);
                const guestsCsv = yield* fetchUpload(row.guestsR2Key);

                const parsedEvents = yield* parseEventsCsv(eventsCsv);
                const parsedFamilies = yield* parseGuestsCsv(guestsCsv, parsedEvents);
                const plan = yield* diffAgainstDb(
                  parsedEvents,
                  parsedFamilies as ParsedFamily[],
                  weddingId,
                );

                const summary = yield* applyImport(importId, plan, weddingId);

                yield* dbQuery(() =>
                  dbService
                    .update(imports)
                    .set({ status: "applied", appliedAt: Date.now() })
                    .where(eq(imports.id, importId))
                    .run(),
                );

                return { summary };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.provideService(R2Service, r2 as R2Bucket),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("FormulaInjectionDetected", () =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Formula-injection guard tripped" };
                  }),
                ),
                Effect.catchTag("MissingRequiredColumn", (e: MissingRequiredColumn) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Missing required column", column: e.column };
                  }),
                ),
                Effect.catchTag("UnmatchedEventColumn", (e: UnmatchedEventColumn) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Unmatched event column", column: e.column };
                  }),
                ),
                Effect.catchTag("MalformedSpreadsheet", () =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Malformed spreadsheet" };
                  }),
                ),
                Effect.catchTag("R2Error", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Storage error" };
                  }),
                ),
                Effect.catchTag("ImportError", () =>
                  Effect.gen(function* () {
                    yield* Effect.logError("import apply failed");
                    set.status = 500;
                    return { error: "Apply failed" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .post(
          "/revert",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const { importId } = yield* Schema.decodeUnknown(RevertBody)(raw);
                const summary = yield* revertImport(importId, weddingId);
                return { summary };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.provideService(R2Service, r2 as R2Bucket),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("NoPriorImport", () =>
                  Effect.sync(() => {
                    set.status = 409;
                    return { error: "No prior applied import to revert to" };
                  }),
                ),
                Effect.catchTag("R2Error", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Storage error" };
                  }),
                ),
                Effect.catchTag("RevertParseError", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Stored CSV failed to re-parse" };
                  }),
                ),
                Effect.catchTag("ImportError", () =>
                  Effect.gen(function* () {
                    yield* Effect.logError("import revert failed");
                    set.status = 500;
                    return { error: "Revert failed" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .get("/list", async ({ weddingId, query, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }

          // Pagination — `?limit=N` (default 50, clamped 1..100) and `?cursor=<ms>`.
          // The cursor is the `uploadedAt` of the last row from the previous page;
          // we ask for `uploadedAt < cursor` and return `nextCursor` so the client
          // can keep walking. Backed by the composite `imports_wedding_uploaded_at_idx`
          // (wedding_id, uploaded_at) index — covers the wedding scope + the
          // uploaded_at cursor/order in one b-tree (P-W1).
          const limitParam = query.limit;
          const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
          const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;

          const cursorParam = query.cursor;
          const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : NaN;
          const hasCursor = Number.isFinite(cursor);

          const scope = eq(imports.weddingId, weddingId);
          const rows = await db
            .select()
            .from(imports)
            .where(hasCursor ? and(scope, lt(imports.uploadedAt, cursor)) : scope)
            .orderBy(desc(imports.uploadedAt))
            .limit(limit + 1)
            .all();

          const page = rows.slice(0, limit);
          const nextCursor =
            rows.length > limit ? (page[page.length - 1]?.uploadedAt ?? null) : null;

          return {
            imports: page.map((r) => ({
              id: r.id,
              uploadedAt: r.uploadedAt,
              format: r.format,
              status: r.status,
              appliedAt: r.appliedAt,
              revertedAt: r.revertedAt,
              summary: (() => {
                try {
                  return JSON.parse(r.summary);
                } catch {
                  return {};
                }
              })(),
            })),
            nextCursor,
          };
        }),
    );
