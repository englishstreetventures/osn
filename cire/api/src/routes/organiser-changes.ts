import { imports } from "@cire/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { runCire } from "../observability";
import { ApplyBody, ChangeScope, DesiredState, RevertBody } from "../schemas/import";
import type { ImportPlan, ParsedFamily } from "../schemas/import";
import {
  currentEventsAsParsed,
  decodeChangeBody,
  GENESIS_REVISION,
  headRevision,
} from "../services/changes";
import { captureBeforeImage, pruneBeforeImages } from "../services/checkpoint";
import { CapacityExceeded } from "../services/entitlements";
import { applyImport, diffAgainstDb } from "../services/import";
import type { DeletableBucket } from "../services/r2-cleanup";
import { R2Service, fetchUpload, storeUpload } from "../services/r2-imports";
import type { R2Bucket } from "../services/r2-imports";
import { revertImport } from "../services/revert";
import { parseEventsCsv, parseGuestsCsv } from "../services/spreadsheet";
import type {
  MalformedSpreadsheetReason,
  SheetKind,
  SpreadsheetParseError,
} from "../services/spreadsheet";

const ONE_MB = 1 * 1024 * 1024;

/**
 * The 422 body for a spreadsheet parse rejection, shared by preview and apply.
 *
 * Every locating detail the parser worked out — `reason`, 1-indexed
 * `row`/`column`, and which `sheet` it came from — is carried through, because
 * a bare `{error: "Malformed spreadsheet"}` tells an organiser nothing about
 * which of two files, which row, or what to change. (Preview used to omit
 * `column` and apply used to omit everything but `error`, so the same bad upload
 * produced two different, equally unhelpful bodies.) `snippet` is deliberately
 * NOT reflected: it is raw cell content from an untrusted upload.
 *
 * WHICH FIELDS ARE TRUSTED (the reason-lockdown contract in
 * `services/spreadsheet.ts`, stated precisely so it stays durable):
 *  - `reason` — a static literal from a closed union. Never cell content.
 *  - `sheet`, `row`, `column` (numeric) — structural metadata we computed.
 *  - `MissingRequiredColumn.column` — always a member of
 *    `REQUIRED_EVENT_COLUMNS`/`REQUIRED_GUEST_COLUMNS`, i.e. our own constant.
 *  - `UnmatchedEventColumn.column` — **untrusted**: a header cell copied
 *    verbatim out of the uploaded file. Reflected (the organiser needs to be
 *    told which heading didn't match) but TRUNCATED, since a cell may be up to
 *    `MAX_CELL_LENGTH`. It is the organiser's own upload coming back to them,
 *    and the client renders it through SolidJS text interpolation, which
 *    escapes — but a future renderer or log sink must treat it as untrusted.
 *  - `FormulaInjectionDetected.snippet` — untrusted, and withheld entirely.
 */

/** Cap on the one untrusted value this body reflects (see above). */
const MAX_REFLECTED_LABEL = 64;

function truncateLabel(s: string): string {
  return s.length > MAX_REFLECTED_LABEL ? `${s.slice(0, MAX_REFLECTED_LABEL)}…` : s;
}
/**
 * The wire body itself — the union of what the four branches below emit, named
 * so the contract above is a type rather than a comment. `reason` is only on a
 * `MalformedSpreadsheet`; `row`/`column` are absent on the two column errors;
 * `sheet` is always present (null when the parser didn't stamp one).
 */
interface ParseErrorBody {
  /** Static, organiser-facing headline for the tag. Never cell content. */
  error: string;
  /** Static literal from a closed union — `MalformedSpreadsheet` only. */
  reason?: MalformedSpreadsheetReason;
  /** 1-indexed row we computed, `null` for a whole-file failure. */
  row?: number | null;
  /** 1-indexed column number, or the (truncated) header text for a column error. */
  column?: number | string | null;
  /** Which uploaded sheet it came from, `null` when unstamped. */
  sheet: SheetKind | null;
}

function parseErrorBody(e: SpreadsheetParseError): ParseErrorBody {
  const sheet = e.sheet ?? null;
  switch (e._tag) {
    case "MalformedSpreadsheet":
      // Wire names stay `row`/`column`; the error's fields are `atRow`/`atColumn`
      // so an unset coordinate can't read back as the runtime's own Error.column
      // (see the note on MalformedSpreadsheet).
      return {
        error: "Malformed spreadsheet",
        reason: e.reason,
        row: e.atRow ?? null,
        column: e.atColumn ?? null,
        sheet,
      };
    case "FormulaInjectionDetected":
      return {
        error: "Formula-injection guard tripped",
        row: e.row,
        column: e.column,
        sheet,
      };
    case "MissingRequiredColumn":
      return { error: "Missing required column", column: e.column, sheet };
    case "UnmatchedEventColumn":
      return { error: "Unmatched event column", column: truncateLabel(e.column), sheet };
  }
}

/**
 * Catch every spreadsheet parse error onto the shared 422 body. One handler for
 * both verbs, so preview and apply can't drift on what they report again.
 */
function catchParseErrors(set: { status?: number | string }) {
  const handle = (e: SpreadsheetParseError) =>
    Effect.gen(function* () {
      if (e._tag === "FormulaInjectionDetected") {
        yield* Effect.logWarning("formula injection rejected", {
          row: e.row,
          column: e.column,
          sheet: e.sheet ?? null,
        });
      }
      set.status = 422;
      return parseErrorBody(e);
    });
  return {
    MalformedSpreadsheet: handle,
    FormulaInjectionDetected: handle,
    MissingRequiredColumn: handle,
    UnmatchedEventColumn: handle,
  };
}

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
  /**
   * Whether an id-less desired row may match an existing row by name. Persisted
   * so the apply-time re-diff matches exactly as the preview did. A row written
   * before this field existed has none — apply then derives it from the change's
   * `kind`, which is a column and always right.
   */
  matchByName?: boolean;
  /**
   * Which halves of the wedding the change is authoritative over — `"both"`
   * unless the organiser uploaded a single sheet. Read back at apply so the
   * re-diff manages exactly the halves the preview did; a legacy row written
   * before partial uploads existed has no `scope` and defaults to `"both"`.
   */
  scope?: ChangeScope;
  eventCreates: number;
  eventUpdates: number;
  eventRemoves: number;
  familyCreates: number;
  familyUpdates: number;
  familyRemoves: number;
  guestCreates: number;
  guestRemoves: number;
  guestUpdates: number;
}

/**
 * Re-derive the DesiredState an apply must re-diff, from the change row's stored
 * inputs. Both front doors persist their input at preview under the row's
 * `eventsR2Key`/`guestsR2Key`:
 *  - `kind = 'import'` — the uploaded CSVs (re-parsed, exactly the import). A
 *    single-sheet upload stored `""` in the slot it didn't carry, so `scope`
 *    (not the stored bytes) decides which slots are read.
 *  - `kind = 'editor'` — the DesiredState JSON in the events key (guests key is
 *    an empty sentinel); JSON-decoded back to a DesiredState.
 *
 * Re-reading at apply is the TOCTOU defence: the DB may have shifted since
 * preview, so the plan is always freshly diffed against live state. For a
 * guests-only change the event list is re-hydrated from LIVE state here too — an
 * event added between preview and apply is therefore a column the guest sheet
 * *could* have resolved, never a stale snapshot.
 */
function desiredStateFromRow(
  row: {
    kind: "import" | "editor";
    eventsR2Key: string;
    guestsR2Key: string;
  },
  scope: ChangeScope,
  weddingId: string,
) {
  return Effect.gen(function* () {
    if (row.kind === "editor") {
      const json = yield* fetchUpload(row.eventsR2Key);
      return yield* Schema.decodeUnknown(Schema.parseJson(DesiredState))(json);
    }
    const events =
      scope === "guests"
        ? yield* currentEventsAsParsed(weddingId)
        : yield* parseEventsCsv(yield* fetchUpload(row.eventsR2Key));
    const families =
      scope === "events"
        ? []
        : ((yield* parseGuestsCsv(yield* fetchUpload(row.guestsR2Key), events)) as ParsedFamily[]);
    return { events, families };
  });
}

/**
 * The general change route factory (guest+event editor E4,
 * [[guest-event-editor]] §7). Mounted at `changes`.
 *
 * osnAuth() gates every request; weddingEditor() proves the caller is the OWNER
 * or an EDITOR co-host of the :weddingId (404 unknown, 403 non-member, 403
 * `read_only_role` viewer), deriving `weddingId`. Every operation is
 * wedding-scoped through the path.
 *
 * The four verbs:
 *  - `preview` — accepts EITHER a DesiredState JSON (editor draft-save) OR a
 *    spreadsheet upload carrying `eventsCsv`, `guestsCsv`, or BOTH (either sheet
 *    may be omitted — an organiser re-working only the guest list uploads only
 *    that sheet, and the schedule is left alone). Both funnel through
 *    `decodeChangeBody` → the one reconcile: DesiredState → `diffAgainstDb` →
 *    plan. Persists a `preview` change row (input in R2, `baseRevision` +
 *    `removeManual` + `scope` in the summary). Returns `{changeId, plan,
 *    warnings, baseRevision, scope}`.
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
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId/changes", (group) =>
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

                const decoded = yield* decodeChangeBody(raw, weddingId);

                // Persist the change's input for the apply-time re-diff. Import:
                // the uploaded CSVs, with `""` in the slot of a sheet the
                // organiser didn't upload (the row's `scope` is what marks it
                // as absent rather than empty). Editor: the DesiredState JSON in
                // the events slot (guests slot empty), with a byte cap on both.
                const changeId = crypto.randomUUID();
                const eventsPayload = decoded.uploadedCsv
                  ? (decoded.uploadedCsv.eventsCsv ?? "")
                  : JSON.stringify(decoded.desiredState);
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
                  {
                    removeManual: decoded.removeManual,
                    scope: decoded.scope,
                    matchByName: decoded.matchByName,
                  },
                );

                const summary: ChangeSummary = {
                  baseRevision,
                  removeManual: decoded.removeManual,
                  matchByName: decoded.matchByName,
                  scope: decoded.scope,
                  eventCreates: plan.eventCreates.length,
                  eventUpdates: plan.eventUpdates.length,
                  eventRemoves: plan.eventRemoves.length,
                  familyCreates: plan.familyCreates.length,
                  familyUpdates: plan.familyUpdates.length,
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
                  `change preview accepted: kind=${decoded.kind} scope=${decoded.scope} families=${decoded.desiredState.families.length} events=${decoded.desiredState.events.length} removeManual=${decoded.removeManual}`,
                  { changeId },
                );

                return {
                  changeId,
                  baseRevision,
                  // Echoed so the preview UI can say WHICH halves this change
                  // touches ("guests only — your schedule is untouched") rather
                  // than leaving an organiser to infer it from empty counts.
                  scope: decoded.scope,
                  plan: {
                    ...plan,
                    eventCreates: [...plan.eventCreates],
                    eventUpdates: [...plan.eventUpdates],
                    eventRemoves: [...plan.eventRemoves],
                    familyCreates: [...plan.familyCreates],
                    familyUpdates: [...plan.familyUpdates],
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
                Effect.catchTags(catchParseErrors(set)),
                Effect.catchTag("StaleDesiredState", (e) =>
                  Effect.gen(function* () {
                    // The draft named rows that no longer exist, so it was built
                    // against state someone else has since changed. Same 409 the
                    // baseRevision guard returns, for the same reason and with the
                    // same remedy — reload and redo the edit — except this race
                    // opened between LOAD and preview, which baseRevision (captured
                    // at preview) cannot see. Refusing beats applying: with no name
                    // fallback those rows reconcile as remove+create, dropping RSVPs
                    // and re-minting a claim code the organiser never asked to touch.
                    yield* Effect.logWarning("change refused: stale desired state", {
                      changeKind: "editor",
                      unresolved: e.unresolved,
                    });
                    set.status = 409;
                    return {
                      error: "State changed — reload the editor",
                      reason: "stale_draft",
                    };
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
                const { changeId } = yield* Schema.decodeUnknown(ApplyBody)(raw);
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
                // provenance toggle AND the sheet scope captured at preview. A
                // row written before partial uploads existed has no `scope`, so
                // it defaults to `"both"` — the historical behaviour.
                // Decoded, not asserted: `summary` is JSON off a DB row, so a
                // legacy/corrupt value must land on the safe default explicitly
                // rather than flowing into `!==` comparisons that happen to be
                // safe today. `"both"` is the conservative choice — it manages
                // both halves, so a partial change degrades to re-parsing an
                // empty slot and 422ing, never to a silent one-sided delete.
                const scope = Option.getOrElse(
                  Schema.decodeUnknownOption(ChangeScope)(stored.scope),
                  (): ChangeScope => "both",
                );
                const desired = yield* desiredStateFromRow(row, scope, weddingId);
                const plan = yield* diffAgainstDb(
                  desired.events,
                  desired.families as ParsedFamily[],
                  weddingId,
                  {
                    removeManual: stored.removeManual ?? false,
                    scope,
                    // Decoded, not asserted — same rule as `scope` above, and it
                    // matters more here: `??` only guards nullish, so a corrupt
                    // falsy-but-present value (`0`, `""`) would sail through and
                    // turn an IMPORT re-diff id-authoritative, making every id-less
                    // sheet row a create and every existing row a removal. A row
                    // written before this field existed falls back to the change's
                    // `kind`: an editor save is id-authoritative, a sheet is not.
                    matchByName: Option.getOrElse(
                      Schema.decodeUnknownOption(Schema.Boolean)(stored.matchByName),
                      () => row.kind !== "editor",
                    ),
                  },
                );

                // E3 checkpoint: snapshot the pre-change state at full fidelity
                // as this change's before-image, then apply, then prune. The
                // status flip rides in applyImport's FINAL batch (its
                // `finalize` statements) so a crash can never leave the data
                // mutated while the row still reads `preview` — that window
                // allowed a second apply, whose before-image capture would
                // overwrite this one with a post-change snapshot and destroy
                // revertability.
                const before = yield* captureBeforeImage(changeId, weddingId);
                const summary = yield* applyImport(changeId, plan, weddingId, [
                  dbService
                    .update(imports)
                    .set({
                      status: "applied",
                      appliedAt: Date.now(),
                      beforeEventsR2Key: before.eventsKey,
                      beforeGuestsR2Key: before.guestsKey,
                    })
                    .where(eq(imports.id, changeId)),
                ]);

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
                Effect.catchTags(catchParseErrors(set)),
                Effect.catchTag("StaleDesiredState", (e) =>
                  Effect.gen(function* () {
                    // The draft named rows that no longer exist, so it was built
                    // against state someone else has since changed. Same 409 the
                    // baseRevision guard returns, for the same reason and with the
                    // same remedy — reload and redo the edit — except this race
                    // opened between LOAD and preview, which baseRevision (captured
                    // at preview) cannot see. Refusing beats applying: with no name
                    // fallback those rows reconcile as remove+create, dropping RSVPs
                    // and re-minting a claim code the organiser never asked to touch.
                    yield* Effect.logWarning("change refused: stale desired state", {
                      changeKind: "editor",
                      unresolved: e.unresolved,
                    });
                    set.status = 409;
                    return {
                      error: "State changed — reload the editor",
                      reason: "stale_draft",
                    };
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
                Effect.catchTag("CapacityExceeded", (e) =>
                  Effect.sync(() => {
                    set.status = 402;
                    return {
                      error: "payment_required",
                      entitlement: "capacity",
                      limit: e.limit,
                      current: e.current,
                    };
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
                const { changeId } = yield* Schema.decodeUnknown(RevertBody)(raw);
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
            // The page is returned under `imports` — the table name — and is
            // keyset-paginated on `uploadedAt`.
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
