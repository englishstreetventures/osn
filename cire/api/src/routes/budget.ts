import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import {
  CreateBudgetItemBody,
  CreatePaymentBody,
  ReorderBudgetItemsBody,
  SetBudgetTotalBody,
  UpdateBudgetItemBody,
  UpdatePaymentBody,
} from "../schemas/budget";
import { budgetService } from "../services/budget";
import { weddingSettingsService } from "../services/wedding-settings";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as the other organiser write routes).
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const itemNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "budget_item_not_found" };
  });

const paymentNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "payment_not_found" };
  });

const weddingNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "wedding_not_found" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

/**
 * Budget v1 — READ surface (platform Phase 1, [[platform-plan]] §4.2):
 *
 *   GET /api/organiser/weddings/:weddingId/budget   (weddingMember — any role incl. viewer)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates the write gates. Mirrors createTaskReadRoutes.
 */
export const createBudgetReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/budget", async ({ weddingId, set }) => {
        if (!weddingId) return internalSync(set);
        return runCire(
          budgetService.get(weddingId).pipe(
            Effect.provideService(DbService, db),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      }),
    );

/**
 * Budget v1 — WRITE surface (platform Phase 1, [[platform-plan]] §4.2):
 *
 *   POST   /budget/items                                   (weddingEditor)
 *   PATCH  /budget/items/reorder                           (weddingEditor)
 *   PATCH  /budget/items/:itemId                           (weddingEditor)
 *   DELETE /budget/items/:itemId                           (weddingEditor)
 *   POST   /budget/items/:itemId/payments                  (weddingEditor)
 *   PATCH  /budget/items/:itemId/payments/:paymentId       (weddingEditor)
 *   DELETE /budget/items/:itemId/payments/:paymentId       (weddingEditor)
 *   PUT    /budget/total                                   (weddingOwner)
 *
 * A viewer gets 403 `read_only_role` on the editor writes; an editor gets 403 on
 * `PUT /budget/total` (owner-only, matching the Settings save it replaces). The
 * service re-scopes every write by wedding_id (payments via their parent item),
 * so a cross-tenant id 404s. `PUT /budget/total` delegates to the settings
 * service so `weddings.budget_total_minor` keeps ONE writer.
 *
 * NOTE `/budget/items/reorder` is registered BEFORE `/budget/items/:itemId` so
 * the literal wins over the param.
 */
export const createBudgetWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        // Editor writes.
        .guard((write) =>
          write
            .use(weddingEditor(db))
            .post(
              "/budget/items",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(CreateBudgetItemBody)(raw);
                    const item = yield* budgetService.createItem({ weddingId, ...body });
                    return { item };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/reorder",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(ReorderBudgetItemsBody)(raw);
                    yield* budgetService.reorderItems(weddingId, body.category, body.orderedIds);
                    return { ok: true as const };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/:itemId",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(UpdateBudgetItemBody)(raw);
                    const item = yield* budgetService.updateItem({
                      weddingId,
                      itemId: params.itemId,
                      patch: body,
                    });
                    return { item };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .delete("/budget/items/:itemId", async ({ weddingId, params, set }) => {
              if (!weddingId) return internalSync(set);
              return runCire(
                budgetService.removeItem(weddingId, params.itemId).pipe(
                  Effect.map(() => ({ ok: true as const })),
                  Effect.provideService(DbService, db),
                  Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            })
            .post(
              "/budget/items/:itemId/payments",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(CreatePaymentBody)(raw);
                    const payment = yield* budgetService.addPayment({
                      weddingId,
                      itemId: params.itemId,
                      label: body.label,
                      amountMinor: body.amountMinor,
                      dueAt: body.dueAt,
                    });
                    return { payment };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/:itemId/payments/:paymentId",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(UpdatePaymentBody)(raw);
                    const payment = yield* budgetService.updatePayment({
                      weddingId,
                      itemId: params.itemId,
                      paymentId: params.paymentId,
                      patch: body,
                    });
                    return { payment };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchTag("PaymentNotInItem", () => paymentNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .delete(
              "/budget/items/:itemId/payments/:paymentId",
              async ({ weddingId, params, set }) => {
                if (!weddingId) return internalSync(set);
                return runCire(
                  budgetService
                    .removePayment({
                      weddingId,
                      itemId: params.itemId,
                      paymentId: params.paymentId,
                    })
                    .pipe(
                      Effect.map(() => ({ ok: true as const })),
                      Effect.provideService(DbService, db),
                      Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                      Effect.catchTag("PaymentNotInItem", () => paymentNotFound(set)),
                      Effect.catchAllDefect(() => internal(set)),
                    ),
                );
              },
            ),
        )
        // Owner-only cap set — delegates to the settings service (single writer
        // of weddings.budget_total_minor).
        .guard((own) =>
          own.use(weddingOwner(db)).put(
            "/budget/total",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(SetBudgetTotalBody)(raw);
                  const settings = yield* weddingSettingsService.update(weddingId, {
                    budgetTotalMinor: body.budgetTotalMinor,
                  });
                  return { budgetTotalMinor: settings.budgetTotalMinor };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("WeddingNotFound", () => weddingNotFound(set)),
                  Effect.catchTag("SettingsWriteError", () => internal(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          ),
        ),
    );
