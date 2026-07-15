import { imports } from "@cire/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { runCire } from "../observability";
import { ApplyBody, DesiredState, RevertBody } from "../schemas/import";
import type { ImportPlan, ParsedFamily } from "../schemas/import";
import { decodeChangeBody, GENESIS_REVISION, headRevision } from "../services/changes";
import { captureBeforeImage, pruneBeforeImages } from "../services/checkpoint";
import { applyImport, diffAgainstDb } from "../services/import";
import type { DeletableBucket } from "../services/r2-cleanup";
import { R2Service, fetchUpload, storeUpload } from "../services/r2-imports";
import type { R2Bucket } from "../services/r2-imports";
import { revertImport } from "../services/revert";
import { parseEventsCsv, parseGuestsCsv } from "../services/spreadsheet";

const ONE_MB = 1 * 1024 * 1024;

// Sentinel parse hook: stops Elysia from consuming the body so handlers can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error.
const manualParse = { parse: () => ({}) };

/**
 * The change persisted-state summary carries the optimistic-concurrency token +
 * provenance toggle captured at PREVIEW, alongside the diff counts. Read back at
 * apply so the re-diff uses the same `removeManual` and the 409 guard compares
 * against the `baseRevision` the previewer saw.
 */
interface ChangeSummary {
  baseRevision: string;
  removeManual: boolean;
  eventCreates: number;
  eventUpdates: number;
  eventRemoves: number;
  familyCreates: number;
  familyRemoves: number;
  guestCreates: number;
  guestRemoves: number;
  guestUpdates: number;
}

/**
 * Re-derive the DesiredState an apply must re-diff, from the change row's stored
 * inputs. Both front doors persist their input at preview under the row's
 * `eventsR2Key`/`guestsR2Key`:
 *  - `kind = 'import'` — the two uploaded CSVs (re-parsed, exactly the import).
 *  - `kind = 'editor'` — the DesiredState JSON in the events key (guests key is
 *    an empty sentinel); JSON-decoded back to a DesiredState.
 * Re-reading at apply is the TOCTOU defence: the DB may have shifted since
 * preview, so the plan is always freshly diffed against live state.
 */
function desiredStateFromRow(row: {
  kind: "import" | "editor";
  eventsR2Key: string;
  guestsR2Key: string;
}) {
  return Effect.gen(function* () {
    if (row.kind === "editor") {
      const json = yield* fetchUpload(row.eventsR2Key);
      return yield* Schema.decodeUnknown(Schema.parseJson(DesiredState))(json);
    }
    const eventsCsv = yield* fetchUpload(row.eventsR2Key);
    const guestsCsv = yield* fetchUpload(row.guestsR2Key);
    const events = yield* parseEventsCsv(eventsCsv);
    const families = yield* parseGuestsCsv(guestsCsv, events);
    return { events, families: families as ParsedFamily[] };
  });
}

/**
 * The general change route factory (guest+event editor E4,
 * [[guest-event-editor]] §7). Mounted at TWO path segments off the same code:
 * `changes` (the general API) and `import` (the one-release alias for existing
 * clients, deleted next release — see [[api]] TODO). Both serve identically.
 *
 * osnAuth() gates every request; weddingEditor() proves the caller is the OWNER
 * or an EDITOR co-host of the :weddingId (404 unknown, 403 non-member, 403
 * `read_only_role` viewer), deriving `weddingId`. Every operation is
 * wedding-scoped through the path.
 *
 * The four verbs:
 *  - `preview` — accepts EITHER a DesiredState JSON (editor draft-save) OR
 *    `{eventsCsv, guestsCsv}` (spreadsheet upload). Both funnel through
 *    `decodeChangeBody` → the one reconcile: DesiredState → `diffAgainstDb` →
 *    plan. Persists a `preview` change row (input in R2, `baseRevision` +
 *    `removeManual` in the summary). Returns `{changeId, plan, warnings,
 *    baseRevision}`.
 *  - `apply` — `{changeId}`. Re-reads the head revision and 409s if it moved
 *    since preview (optimistic concurrency — a co-host applied in between).
 *    Re-diffs against live state (TOCTOU), checkpoints the before-image (E3),
 *    applies, prunes.
 *  - `revert` — `{changeId}`. Before-image restore (E3).
 *  - `list` — paginated change history (imports + editor saves).
 */
export const createOrganiserChangeRoutes = (
  db: Db,
  r2: R2Bucket | undefined,
  osnAuthOptions: OsnAuthOptions,
  /** Path segment to mount under: `"changes"` (canonical) or `"import"` (alias). */
  segment: "changes" | "import",
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group(`/weddings/:weddingId/${segment}`, (group) =>
      group
        .use(weddingEditor(db))
        .post(
          "/preview",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }

            // Content-Length pre-check — reject obviously-oversized payloads
            // BEFORE paying to parse JSON. The post-parse byte check below is a
            // backup (some CDNs strip / lie about Content-Length).
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
                // Capture the head BEFORE diffing so a concurrent apply between
                // this read and the client's later apply is what trips the 409,
                // never our own diff reads.
                const baseRevision = yield* headRevision(weddingId);

                const decoded = yield* decodeChangeBody(raw);

                // Persist the change's input for the apply-time re-diff. Import:
                // the two uploaded CSVs. Editor: the DesiredState JSON in the
                // events slot (guests slot empty), with a byte cap on both.
                const changeId = crypto.randomUUID();
                const eventsPayload =
                  decoded.uploadedCsv?.eventsCsv ?? JSON.stringify(decoded.desiredState);
                const guestsPayload = decoded.uploadedCsv?.guestsCsv ?? "";
                const totalBytes =
                  new TextEncoder().encode(eventsPayload).length +
                  new TextEncoder().encode(guestsPayload).length;
                if (totalBytes > ONE_MB) {
                  set.status = 413;
                  return { error: "Upload too large (max 1MB total)" };
                }
                const { eventsKey, guestsKey } = yield* storeUpload(
                  eventsPayload,
                  guestsPayload,
                  changeId,
                );

                const plan: ImportPlan = yield* diffAgainstDb(
                  decoded.desiredState.events,
                  decoded.desiredState.families as ParsedFamily[],
                  weddingId,
                  { removeManual: decoded.removeManual },
                );

                const summary: ChangeSummary = {
                  baseRevision,
                  removeManual: decoded.removeManual,
                  eventCreates: plan.eventCreates.length,
                  eventUpdates: plan.eventUpdates.length,
                  eventRemoves: plan.eventRemoves.length,
                  familyCreates: plan.familyCreates.length,
                  familyRemoves: plan.familyRemoves.length,
                  guestCreates: plan.guestCreates.length,
                  guestRemoves: plan.guestRemoves.length,
                  guestUpdates: plan.guestUpdates.length,
                };

                const dbService = yield* DbService;
                yield* dbQuery(() =>
                  dbService
                    .insert(imports)
                    .values({
                      id: changeId,
                      weddingId,
                      uploadedAt: Date.now(),
                      format: "csv",
                      eventsR2Key: eventsKey,
                      guestsR2Key: guestsKey,
                      summary: JSON.stringify(summary),
                      status: "preview",
                      kind: decoded.kind,
                    })
                    .run(),
                );

                yield* Effect.logInfo(
                  `change preview accepted: kind=${decoded.kind} families=${decoded.desiredState.families.length} events=${decoded.desiredState.events.length} removeManual=${decoded.removeManual}`,
                  { changeId },
                );

                return {
                  changeId,
                  // One-release alias compatibility: legacy `/import/*` clients
                  // read `importId` from the preview response and echo it to
                  // apply. Return it alongside `changeId` (same value) so both
                  // prefixes serve identically until the alias is deleted.
                  importId: changeId,
                  baseRevision,
                  plan: {
                    ...plan,
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
                Effect.catchTag("FormulaInjectionDetected", (e) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(`formula injection rejected`, {
                      row: e.row,
                      column: e.column,
                    });
                    set.status = 422;
                    return {
                      error: "Formula-injection guard tripped",
                      row: e.row,
                      column: e.column,
                    };
                  }),
                ),
                Effect.catchTag("MissingRequiredColumn", (e) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Missing required column", column: e.column };
                  }),
                ),
                Effect.catchTag("UnmatchedEventColumn", (e) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Unmatched event column", column: e.column };
                  }),
                ),
                Effect.catchTag("MalformedSpreadsheet", (e) =>
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
                const { importId: changeId } = yield* Schema.decodeUnknown(ApplyBody)(raw);
                const dbService = yield* DbService;

                const [row] = yield* dbQuery(() =>
                  dbService.select().from(imports).where(eq(imports.id, changeId)).all(),
                );
                // A foreign wedding's change is indistinguishable from a missing one.
                if (!row || row.weddingId !== weddingId) {
                  set.status = 404;
                  return { error: "Change not found" };
                }
                if (row.status !== "preview") {
                  set.status = 409;
                  return { error: "Change is not in preview status" };
                }

                // ── Optimistic concurrency (§6) ─────────────────────────────
                // The `baseRevision` the previewer saw is stamped on the row.
                // If the wedding's head moved since (a co-host applied in
                // between), 409 so the organiser re-previews against fresh
                // state instead of silently over-writing the other edit.
                const stored = (() => {
                  try {
                    return JSON.parse(row.summary) as Partial<ChangeSummary>;
                  } catch {
                    return {} as Partial<ChangeSummary>;
                  }
                })();
                const baseRevision = stored.baseRevision ?? GENESIS_REVISION;
                const currentHead = yield* headRevision(weddingId);
                if (currentHead !== baseRevision) {
                  set.status = 409;
                  return {
                    error: "State changed — re-preview",
                    baseRevision,
                    currentRevision: currentHead,
                  };
                }

                // Re-derive the desired state from the row's stored input and
                // re-diff against LIVE state (TOCTOU defence), honouring the
                // provenance toggle captured at preview.
                const desired = yield* desiredStateFromRow(row);
                const plan = yield* diffAgainstDb(
                  desired.events,
                  desired.families as ParsedFamily[],
                  weddingId,
                  { removeManual: stored.removeManual ?? false },
                );

                // E3 checkpoint: snapshot the pre-change state at full fidelity
                // as this change's before-image, then apply, then prune.
                const before = yield* captureBeforeImage(changeId, weddingId);
                const summary = yield* applyImport(changeId, plan, weddingId);

                yield* dbQuery(() =>
                  dbService
                    .update(imports)
                    .set({
                      status: "applied",
                      appliedAt: Date.now(),
                      beforeEventsR2Key: before.eventsKey,
                      beforeGuestsR2Key: before.guestsKey,
                    })
                    .where(eq(imports.id, changeId))
                    .run(),
                );

                yield* pruneBeforeImages(weddingId, r2 as DeletableBucket | undefined);

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
                Effect.catchTag("MissingRequiredColumn", (e) =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "Missing required column", column: e.column };
                  }),
                ),
                Effect.catchTag("UnmatchedEventColumn", (e) =>
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
                    yield* Effect.logError("change apply failed");
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
                const { importId: changeId } = yield* Schema.decodeUnknown(RevertBody)(raw);
                const summary = yield* revertImport(changeId, weddingId);
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
                    return { error: "No prior applied change to revert to" };
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
                    yield* Effect.logError("change revert failed");
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

          // Pagination — `?limit=N` (default 50, clamped 1..100) and
          // `?cursor=<ms>` (the `uploadedAt` of the last row of the previous
          // page). Backed by the composite (wedding_id, uploaded_at) index.
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
            // The history list is exposed under both `imports` (legacy clients)
            // and `changes` (new clients) so both prefixes serve identically.
            imports: page.map((r) => ({
              id: r.id,
              uploadedAt: r.uploadedAt,
              format: r.format,
              status: r.status,
              kind: r.kind,
              appliedAt: r.appliedAt,
              revertedAt: r.revertedAt,
              revertable: Boolean(r.beforeEventsR2Key && r.beforeGuestsR2Key),
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
