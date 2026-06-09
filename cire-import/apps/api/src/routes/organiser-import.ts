import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { desc, eq, lt } from "drizzle-orm";
import { imports } from "@cire/db";
import { constantTimeEqual } from "../lib/timing";
import { DbService } from "../db";
import { R2Service, fetchUpload, storeUpload } from "../services/r2-imports";
import {
  parseEventsCsv,
  parseGuestsCsv,
  FormulaInjectionDetected,
  MissingRequiredColumn,
  UnmatchedEventColumn,
  MalformedSpreadsheet,
} from "../services/spreadsheet";
import { applyImport, diffAgainstDb } from "../services/import";
import { revertImport } from "../services/revert";
import { ApplyBody, PreviewBody, RevertBody } from "../schemas/import";
import type { ImportPlan, ParsedFamily } from "../schemas/import";
import type { Db } from "../db";
import type { R2Bucket } from "../services/r2-imports";

const ONE_MB = 1 * 1024 * 1024;

type AppVariables = {
  db: Db;
  r2: R2Bucket;
  organiserToken: string;
};

export const organiserImportRoute = new Hono<{ Variables: AppVariables }>();

/**
 * Shared-secret gate. The header `X-Organiser-Token` must match
 * `env.ORGANISER_TOKEN` (CF secret) — wired into context as `organiserToken`.
 * Migrate to passkey auth after MVP.
 */
organiserImportRoute.use("*", async (c, next) => {
  const expected = c.var.organiserToken;
  const got = c.req.header("X-Organiser-Token");
  if (!expected || !got || !constantTimeEqual(got, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

organiserImportRoute.post("/preview", async (c) => {
  // Content-Length pre-check — reject obviously-oversized payloads BEFORE we
  // pay the cost of parsing JSON. We keep the post-parse byte check below as
  // a backup since some CDNs strip / lie about Content-Length.
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > ONE_MB) {
      return c.json({ error: "Payload too large" }, 413);
    }
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = null;
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Schema.decodeUnknown(PreviewBody)(raw);

      const totalBytes =
        new TextEncoder().encode(body.eventsCsv).length +
        new TextEncoder().encode(body.guestsCsv).length;
      if (totalBytes > ONE_MB) {
        return c.json({ error: "Upload too large (max 1MB total)" }, 413);
      }

      const importId = crypto.randomUUID();
      const { eventsKey, guestsKey } = yield* storeUpload(body.eventsCsv, body.guestsCsv, importId);

      const parsedEvents = yield* parseEventsCsv(body.eventsCsv);
      const parsedFamilies = yield* parseGuestsCsv(body.guestsCsv, parsedEvents);
      const plan: ImportPlan = yield* diffAgainstDb(parsedEvents, parsedFamilies as ParsedFamily[]);

      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: importId,
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
        .run();

      yield* Effect.logInfo(
        `import preview accepted: families=${parsedFamilies.length} guests=${parsedFamilies.reduce((n, f) => n + f.guests.length, 0)} events=${parsedEvents.length}`,
        { importId },
      );

      return c.json({
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
      });
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.provideService(R2Service, c.var.r2),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("FormulaInjectionDetected", (e: FormulaInjectionDetected) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`formula injection rejected`, {
            row: e.row,
            column: e.column,
          });
          // Surface coords but NOT contents. Snippet stays in logs only.
          return c.json(
            { error: "Formula-injection guard tripped", row: e.row, column: e.column },
            422,
          );
        }),
      ),
      Effect.catchTag("MissingRequiredColumn", (e: MissingRequiredColumn) =>
        Effect.succeed(c.json({ error: "Missing required column", column: e.column }, 422)),
      ),
      Effect.catchTag("UnmatchedEventColumn", (e: UnmatchedEventColumn) =>
        Effect.succeed(c.json({ error: "Unmatched event column", column: e.column }, 422)),
      ),
      Effect.catchTag("MalformedSpreadsheet", (e: MalformedSpreadsheet) =>
        Effect.succeed(
          c.json({ error: "Malformed spreadsheet", reason: e.reason, row: e.row ?? null }, 422),
        ),
      ),
      Effect.catchTag("R2Error", () => Effect.succeed(c.json({ error: "Storage error" }, 500))),
    ),
  );
});

organiserImportRoute.post("/apply", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = null;
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const { importId } = yield* Schema.decodeUnknown(ApplyBody)(raw);
      const db = yield* DbService;

      const [row] = db.select().from(imports).where(eq(imports.id, importId)).all();
      if (!row) return c.json({ error: "Import not found" }, 404);
      if (row.status !== "preview") {
        return c.json({ error: "Import is not in preview status" }, 409);
      }

      // Re-fetch CSV from R2 and re-diff (TOCTOU defence — DB may have shifted
      // since the preview snapshot).
      const eventsCsv = yield* fetchUpload(row.eventsR2Key);
      const guestsCsv = yield* fetchUpload(row.guestsR2Key);

      const parsedEvents = yield* parseEventsCsv(eventsCsv);
      const parsedFamilies = yield* parseGuestsCsv(guestsCsv, parsedEvents);
      const plan = yield* diffAgainstDb(parsedEvents, parsedFamilies as ParsedFamily[]);

      const summary = yield* applyImport(importId, plan);

      db.update(imports)
        .set({ status: "applied", appliedAt: Date.now() })
        .where(eq(imports.id, importId))
        .run();

      return c.json({ summary });
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.provideService(R2Service, c.var.r2),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("FormulaInjectionDetected", () =>
        Effect.succeed(c.json({ error: "Formula-injection guard tripped" }, 422)),
      ),
      Effect.catchTag("MissingRequiredColumn", (e: MissingRequiredColumn) =>
        Effect.succeed(c.json({ error: "Missing required column", column: e.column }, 422)),
      ),
      Effect.catchTag("UnmatchedEventColumn", (e: UnmatchedEventColumn) =>
        Effect.succeed(c.json({ error: "Unmatched event column", column: e.column }, 422)),
      ),
      Effect.catchTag("MalformedSpreadsheet", () =>
        Effect.succeed(c.json({ error: "Malformed spreadsheet" }, 422)),
      ),
      Effect.catchTag("R2Error", () => Effect.succeed(c.json({ error: "Storage error" }, 500))),
      Effect.catchTag("ImportError", () =>
        Effect.gen(function* () {
          yield* Effect.logError("import apply failed");
          return c.json({ error: "Apply failed" }, 500);
        }),
      ),
    ),
  );
});

organiserImportRoute.post("/revert", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = null;
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const { importId } = yield* Schema.decodeUnknown(RevertBody)(raw);
      const summary = yield* revertImport(importId);
      return c.json({ summary });
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.provideService(R2Service, c.var.r2),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("NoPriorImport", () =>
        Effect.succeed(c.json({ error: "No prior applied import to revert to" }, 409)),
      ),
      Effect.catchTag("R2Error", () => Effect.succeed(c.json({ error: "Storage error" }, 500))),
      Effect.catchTag("RevertParseError", () =>
        Effect.succeed(c.json({ error: "Stored CSV failed to re-parse" }, 500)),
      ),
      Effect.catchTag("ImportError", () =>
        Effect.gen(function* () {
          yield* Effect.logError("import revert failed");
          return c.json({ error: "Revert failed" }, 500);
        }),
      ),
    ),
  );
});

organiserImportRoute.get("/list", (c) => {
  const db = c.var.db;

  // Pagination — `?limit=N` (default 50, clamped 1..100) and `?cursor=<ms>`.
  // The cursor is the `uploadedAt` of the last row from the previous page;
  // we ask for `uploadedAt < cursor` and return `nextCursor` so the client
  // can keep walking. Backed by the `imports_status_uploaded_at_idx` index.
  const limitParam = c.req.query("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;

  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : NaN;
  const hasCursor = Number.isFinite(cursor);

  const baseQuery = db.select().from(imports);
  const filtered = hasCursor ? baseQuery.where(lt(imports.uploadedAt, cursor)) : baseQuery;
  const rows = filtered
    .orderBy(desc(imports.uploadedAt))
    .limit(limit + 1)
    .all();

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.uploadedAt ?? null) : null;

  return c.json({
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
  });
});
