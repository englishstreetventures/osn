import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import {
  ChartQuery,
  CreatePlanBody,
  CreateTableBody,
  RenamePlanBody,
  ReorderTablesBody,
  SeatGuestBody,
  SelectPlanBody,
  UpdateTableBody,
} from "../schemas/seating";
import { seatingService } from "../services/seating";

// Sentinel parse hook — the handler parses by hand, so a malformed payload
// degrades to the schema's 400 rather than a framework parse error.
const manualParse = { parse: () => ({}) };

type SetLike = { status?: number | string };

/** A refusal with its status and the reason the portal reads. */
const refuse = (set: SetLike, status: number, error: string) =>
  Effect.sync(() => {
    set.status = status;
    return { error };
  });

const invalidBody = (set: SetLike) => refuse(set, 400, "Missing or invalid fields");

/** The role gate always provides the wedding; without it the request cannot
 *  be scoped, so it is refused rather than guessed. */
const noWedding = (set: SetLike) => {
  set.status = 500;
  return { error: "Internal error" };
};

/** A defect: logged with the wedding only — a chart carries guest names, and
 *  a plan or table name may name a person, and none of them belongs in a log
 *  line — and answered as a generic 500. */
const defect = (set: SetLike, weddingId: string, operation: string) =>
  Effect.logError("seating request failed", { weddingId, operation }).pipe(
    Effect.andThen(refuse(set, 500, "Internal error")),
  );

/**
 * Seating chart — READ surface:
 *
 *   GET /api/organiser/weddings/:weddingId/seating/events/:eventId[?plan=<planId>]
 *
 * `weddingMember` — every co-host who reads modules, a viewer included.
 */
const createSeatingReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(weddingTier(db, "gold"))
        .get("/seating/events/:eventId", ({ weddingId, params, query, set }) => {
          if (!weddingId) return noWedding(set);
          // Guest names and replies: never cached between requests.
          set.headers["cache-control"] = "no-store";
          return runCire(
            Effect.gen(function* () {
              const { plan } = yield* Schema.decodeUnknownEffect(ChartQuery)(query);
              return yield* seatingService.chart(weddingId, params.eventId, plan);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTags({
                SchemaError: () => invalidBody(set),
                SeatingEventNotFound: () => refuse(set, 404, "event_not_found"),
                SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
              }),
              Effect.catchDefect(() => defect(set, weddingId, "chart")),
            ),
          );
        }),
    );

/**
 * Seating plans — the writes that copy or delete a whole plan:
 *
 *   POST   …/seating/events/:eventId/plans                {name, copyFrom?}
 *   DELETE …/seating/plans/:planId
 *
 * Each can write or delete a plan's every table and seat, so both sit behind a
 * per-user limiter, mounted after osnAuth and before the editor gate so a
 * refused request costs the session lookup alone. A copy is also refused,
 * 409 `copy_budget`, past the rows a wedding may copy in one UTC day
 * (`MAX_COPIED_ROWS_PER_DAY`). `weddingEditor` — a viewer gets 403
 * `read_only_role`.
 */
const createSeatingPlanRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .use(rateLimitMiddlewareByUser(limiter))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(weddingTier(db, "gold"))
        .post(
          "/seating/events/:eventId/plans",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(CreatePlanBody)(raw);
                const plan = yield* seatingService.createPlan({
                  weddingId,
                  eventId: params.eventId,
                  name: body.name,
                  copyFrom: body.copyFrom,
                });
                return { plan };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingEventNotFound: () => refuse(set, 404, "event_not_found"),
                  SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                  SeatingPlanLimit: () => refuse(set, 409, "plan_limit"),
                  SeatingCopyBudget: () => refuse(set, 409, "copy_budget"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "createPlan")),
              ),
            );
          },
          manualParse,
        )
        .delete("/seating/plans/:planId", ({ weddingId, params, set }) => {
          if (!weddingId) return noWedding(set);
          return runCire(
            seatingService.removePlan(weddingId, params.planId).pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.provideService(DbService, db),
              Effect.catchTags({
                SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                SeatingPlanSelected: () => refuse(set, 409, "plan_selected"),
              }),
              Effect.catchDefect(() => defect(set, weddingId, "removePlan")),
            ),
          );
        }),
    );

/**
 * Seating chart — WRITE surface:
 *
 *   POST   …/seating/events/:eventId/tables               {name, capacity}
 *   PATCH  …/seating/events/:eventId/tables/reorder       {orderedIds}
 *   PUT    …/seating/events/:eventId/guests/:guestId      {tableId | null}
 *   PUT    …/seating/events/:eventId/selected-plan        {planId}
 *   PATCH  …/seating/plans/:planId                        {name}
 *   POST   …/seating/plans/:planId/tables                 {name, capacity}
 *   PATCH  …/seating/plans/:planId/tables/reorder         {orderedIds}
 *   PUT    …/seating/plans/:planId/guests/:guestId        {tableId | null}
 *   PATCH  …/seating/tables/:tableId                      {name?, capacity?}
 *   DELETE …/seating/tables/:tableId
 *
 * The three addresses under `…/events/:eventId/` other than `selected-plan`
 * act on the event's plan in use. A table added there makes that plan when the
 * event has none, which is how an event's first table is set out; the reorder
 * and the seat are the addresses the portal from before plans calls.
 *
 * `weddingEditor` — a viewer gets 403 `read_only_role`. Every statement in the
 * service also scopes by the wedding, so another wedding's event, plan, table
 * or guest answers 404.
 */
const createSeatingWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(weddingTier(db, "gold"))
        .post(
          "/seating/events/:eventId/tables",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(CreateTableBody)(raw);
                const table = yield* seatingService.createTableAtEvent({
                  weddingId,
                  eventId: params.eventId,
                  name: body.name,
                  capacity: body.capacity,
                });
                return { table };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingEventNotFound: () => refuse(set, 404, "event_not_found"),
                  SeatingTableLimit: () => refuse(set, 409, "table_limit"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "createTable")),
              ),
            );
          },
          manualParse,
        )
        .patch(
          "/seating/events/:eventId/tables/reorder",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(ReorderTablesBody)(raw);
                yield* seatingService.reorderTablesAtEvent(
                  weddingId,
                  params.eventId,
                  body.orderedIds,
                );
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () => invalidBody(set)),
                Effect.catchDefect(() => defect(set, weddingId, "reorderTables")),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/seating/events/:eventId/guests/:guestId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(SeatGuestBody)(raw);
                return yield* seatingService.seatAtEvent({
                  weddingId,
                  eventId: params.eventId,
                  guestId: params.guestId,
                  tableId: body.tableId,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingEventNotFound: () => refuse(set, 404, "event_not_found"),
                  SeatingTableNotFound: () => refuse(set, 404, "table_not_found"),
                  SeatingGuestNotFound: () => refuse(set, 404, "guest_not_found"),
                  SeatingHouseholdWithdrawn: () => refuse(set, 409, "household_withdrawn"),
                  SeatingTableFull: () => refuse(set, 409, "table_full"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "seat")),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/seating/events/:eventId/selected-plan",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(SelectPlanBody)(raw);
                yield* seatingService.selectPlan({
                  weddingId,
                  eventId: params.eventId,
                  planId: body.planId,
                });
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "selectPlan")),
              ),
            );
          },
          manualParse,
        )
        .patch(
          "/seating/plans/:planId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(RenamePlanBody)(raw);
                const plan = yield* seatingService.renamePlan({
                  weddingId,
                  planId: params.planId,
                  name: body.name,
                });
                return { plan };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "renamePlan")),
              ),
            );
          },
          manualParse,
        )
        .post(
          "/seating/plans/:planId/tables",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(CreateTableBody)(raw);
                const table = yield* seatingService.createTable({
                  weddingId,
                  planId: params.planId,
                  name: body.name,
                  capacity: body.capacity,
                });
                return { table };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                  SeatingTableLimit: () => refuse(set, 409, "table_limit"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "createTable")),
              ),
            );
          },
          manualParse,
        )
        // `…/plans/:planId/tables/reorder` and `…/seating/tables/:tableId`
        // differ in their second segment, so neither path can shadow the other.
        .patch(
          "/seating/plans/:planId/tables/reorder",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(ReorderTablesBody)(raw);
                yield* seatingService.reorderTables(weddingId, params.planId, body.orderedIds);
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () => invalidBody(set)),
                Effect.catchDefect(() => defect(set, weddingId, "reorderTables")),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/seating/plans/:planId/guests/:guestId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(SeatGuestBody)(raw);
                return yield* seatingService.seat({
                  weddingId,
                  planId: params.planId,
                  guestId: params.guestId,
                  tableId: body.tableId,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingPlanNotFound: () => refuse(set, 404, "plan_not_found"),
                  SeatingTableNotFound: () => refuse(set, 404, "table_not_found"),
                  SeatingGuestNotFound: () => refuse(set, 404, "guest_not_found"),
                  SeatingHouseholdWithdrawn: () => refuse(set, 409, "household_withdrawn"),
                  SeatingTableFull: () => refuse(set, 409, "table_full"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "seat")),
              ),
            );
          },
          manualParse,
        )
        .patch(
          "/seating/tables/:tableId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return noWedding(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(UpdateTableBody)(raw);
                const table = yield* seatingService.updateTable({
                  weddingId,
                  tableId: params.tableId,
                  name: body.name,
                  capacity: body.capacity,
                });
                return { table };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () => invalidBody(set),
                  SeatingTableNotFound: () => refuse(set, 404, "table_not_found"),
                  SeatingCapacityBelowSeated: () => refuse(set, 409, "capacity_below_seated"),
                }),
                Effect.catchDefect(() => defect(set, weddingId, "updateTable")),
              ),
            );
          },
          manualParse,
        )
        .delete("/seating/tables/:tableId", ({ weddingId, params, set }) => {
          if (!weddingId) return noWedding(set);
          return runCire(
            seatingService.removeTable(weddingId, params.tableId).pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.provideService(DbService, db),
              Effect.catchTag("SeatingTableNotFound", () => refuse(set, 404, "table_not_found")),
              Effect.catchDefect(() => defect(set, weddingId, "removeTable")),
            ),
          );
        }),
    );

/**
 * The seating chart's module router, `/api/organiser/weddings/:weddingId/seating`.
 * Three sibling instances so the read gate (`weddingMember`), the write gate
 * (`weddingEditor`) and the plan limiter never apply to each other's routes.
 * All sit behind the Gold tier gate, so a wedding below Gold gets 402
 * `payment_required`. The venue file, `seating.csv`, is an owner download and
 * lives with the other CSV exports (`createOrganiserExportRoutes`); it prints
 * each event's selected plan.
 */
export const createSeatingRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  planLimiter: RateLimiterBackend,
) =>
  new Elysia()
    .use(createSeatingReadRoutes(db, osnAuthOptions))
    .use(createSeatingPlanRoutes(db, osnAuthOptions, planLimiter))
    .use(createSeatingWriteRoutes(db, osnAuthOptions));
