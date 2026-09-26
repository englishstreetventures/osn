import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { runCire } from "../observability";
import { FaqEntryBody, FaqOrderBody } from "../schemas/invite-faq";
import { inviteFaqService } from "../services/invite-faq";

// Sentinel parse hook — the handlers parse JSON by hand so a malformed body
// degrades to the schema's 400, as the other organiser write routes do.
const manualParse = { parse: () => ({}) };

const internalError = { error: "Internal error" } as const;

/**
 * The invite FAQ's organiser WRITES, a sibling instance under /api/organiser.
 * The organiser READ is `GET /weddings/:weddingId/invite?include=faqs`, beside
 * the rest of the customisation (`routes/invite.ts`).
 *
 *   POST   /weddings/:weddingId/invite/faqs          → add an entry at the end
 *   PUT    /weddings/:weddingId/invite/faqs/order    → store a new order
 *   PUT    /weddings/:weddingId/invite/faqs/:faqId   → replace question + answer
 *   DELETE /weddings/:weddingId/invite/faqs/:faqId   → delete an entry
 *
 * Behind `weddingEditor()` (owner or editor co-host; a viewer gets 403
 * `read_only_role`) and the invite builder's per-IP write limiter, which it
 * shares with the rest of the invite surface. The service re-scopes every
 * write by wedding, so another wedding's id is a 404 `faq_not_found`.
 *
 * PUT, not PATCH: the API's CORS allow-list (`app.ts`) does not list PATCH,
 * so a browser would refuse the preflight. `/order` is registered before
 * `/:faqId` so the literal wins over the param.
 */
export const createInviteFaqRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .post(
          "/invite/faqs",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return internalError;
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(FaqEntryBody)(raw);
                const faq = yield* inviteFaqService.create(weddingId, body);
                return { faq };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("FaqLimitReached", () =>
                  Effect.sync(() => {
                    set.status = 409;
                    return { error: "faq_limit_reached" };
                  }),
                ),
                Effect.catchDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite faq create failed", { weddingId });
                    set.status = 500;
                    return internalError;
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/invite/faqs/order",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return internalError;
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(FaqOrderBody)(raw);
                yield* inviteFaqService.reorder(weddingId, body.orderedIds);
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite faq reorder failed", { weddingId });
                    set.status = 500;
                    return internalError;
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .put(
          "/invite/faqs/:faqId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return internalError;
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(FaqEntryBody)(raw);
                const faq = yield* inviteFaqService.update(weddingId, params.faqId, body);
                return { faq };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("FaqNotInWedding", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "faq_not_found" };
                  }),
                ),
                Effect.catchDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite faq update failed", { weddingId });
                    set.status = 500;
                    return internalError;
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .delete("/invite/faqs/:faqId", async ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return internalError;
          }
          return runCire(
            inviteFaqService.remove(weddingId, params.faqId).pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.provideService(DbService, db),
              Effect.catchTag("FaqNotInWedding", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "faq_not_found" };
                }),
              ),
              Effect.catchDefect(() =>
                Effect.gen(function* () {
                  yield* Effect.logError("invite faq delete failed", { weddingId });
                  set.status = 500;
                  return internalError;
                }),
              ),
            ),
          );
        }),
    );
