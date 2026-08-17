import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { metricRegistryGift, metricRegistryItemWrite } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingEntitlement } from "../middleware/wedding-entitlement";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import {
  CreateRegistryItemBody,
  GiftKindSchema,
  ReorderRegistryItemsBody,
  SetThankedBody,
  UpdateRegistryItemBody,
  UpdateRegistrySettingsBody,
} from "../schemas/registry";
import { registryService } from "../services/registry";

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
    return { error: "registry_item_not_found" };
  });

const giftNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "registry_gift_not_found" };
  });

const conflict = (set: { status?: number | string }, error: string) =>
  Effect.sync(() => {
    set.status = 409;
    return { error };
  });

const badRequestCode = (set: { status?: number | string }, error: string) =>
  Effect.sync(() => {
    set.status = 400;
    return { error };
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
 * Log a defect before it becomes an anonymous 500 (S-L1). Annotated with the
 * wedding id and NOTHING else — a registry payload carries guest names, gift
 * notes and thank-you text, none of which belongs in a log line.
 */
const logDefect = (weddingId: string) => (cause: unknown) =>
  Effect.logError("registry handler defect", cause).pipe(Effect.annotateLogs({ weddingId }));

/** `?giftsOffset=` → a non-negative integer. Anything unparseable reads as 0. */
function parseGiftsOffset(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Gift registry — READ surface (platform Phase 4, [[registry]]):
 *
 *   GET /api/organiser/weddings/:weddingId/registry   (weddingMember + entitlement)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates the write gates — mirrors createBudgetReadRoutes.
 *
 * LOCKED: `weddingEntitlement(db, "registry")` sits after the role gate, and the
 * `registry` entitlement is granted to no wedding, so this answers
 * 402 `payment_required` for every caller today. That is the whole mechanism by
 * which the feature ships built but unreachable — the portal turns the 402 into
 * the upsell panel.
 */
export const createRegistryReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(weddingEntitlement(db, "registry"))
        .get("/registry", async ({ weddingId, query, set }) => {
          if (!weddingId) return internalSync(set);
          // The gift log is paged; the offset is the only knob the client gets.
          // The service clamps it — this only has to turn a string into a number.
          const giftsOffset = parseGiftsOffset((query as Record<string, unknown>)?.giftsOffset);
          return runCire(
            registryService.get(weddingId, { giftsOffset }).pipe(
              Effect.provideService(DbService, db),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        }),
    );

/**
 * Gift registry — WRITE surface:
 *
 *   PUT    /registry/settings                        (weddingEditor)
 *   POST   /registry/items                           (weddingEditor)
 *   PATCH  /registry/items/reorder                   (weddingEditor)
 *   PATCH  /registry/items/:itemId                   (weddingEditor)
 *   DELETE /registry/items/:itemId                   (weddingEditor)
 *   POST   /registry/gifts/:kind/:giftId/thanked     (weddingEditor)
 *
 * A viewer gets 403 `read_only_role`; a wedding without the entitlement gets 402.
 * The service re-scopes every write by wedding_id, so a cross-tenant id 404s.
 *
 * NOTE `/registry/items/reorder` is registered BEFORE `/registry/items/:itemId`
 * so the literal wins over the param.
 *
 * `FamilyNotInWedding` has no mapping here on purpose: it can only come out of
 * `registryService.claim`, which the GUEST surface will call. It gets its 404
 * when that route lands, alongside the claim/release endpoints.
 *
 * Stripe onboarding (`/registry/stripe/*`, weddingOwner — connecting a bank
 * account is an owner action) lands with the Connect work; it is deliberately
 * absent rather than stubbed, so nothing here implies a payment path exists yet.
 */
export const createRegistryWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.guard((write) =>
        write
          .use(weddingEditor(db))
          .use(weddingEntitlement(db, "registry"))
          .put(
            "/registry/settings",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(UpdateRegistrySettingsBody)(raw);
                  // The cash-gifts/Stripe invariant lives in the service (S-M3),
                  // not here: this route used to load the WHOLE snapshot — items,
                  // gift log, currency — to read one boolean off it (P-C2).
                  const settings = yield* registryService.updateSettings(weddingId, body);
                  return { settings };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("StripeNotReady", () => conflict(set, "stripe_not_ready")),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .post(
            "/registry/items",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(CreateRegistryItemBody)(raw);
                  const item = yield* registryService.createItem({ weddingId, ...body });
                  yield* Effect.sync(() => metricRegistryItemWrite("create"));
                  return { item };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("InvalidQuantity", () => badRequest(set)),
                  Effect.catchTag("ImageKeyNotInWedding", () =>
                    badRequestCode(set, "image_key_not_in_wedding"),
                  ),
                  Effect.catchTag("RegistryItemLimitReached", () =>
                    conflict(set, "registry_item_limit_reached"),
                  ),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .patch(
            "/registry/items/reorder",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(ReorderRegistryItemsBody)(raw);
                  yield* registryService.reorderItems(weddingId, body.orderedIds);
                  return { ok: true as const };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .patch(
            "/registry/items/:itemId",
            async ({ weddingId, params, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(UpdateRegistryItemBody)(raw);
                  const item = yield* registryService.updateItem({
                    weddingId,
                    itemId: params.itemId,
                    patch: body,
                  });
                  yield* Effect.sync(() => metricRegistryItemWrite("update"));
                  return { item };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("InvalidQuantity", () => badRequest(set)),
                  Effect.catchTag("ImageKeyNotInWedding", () =>
                    badRequestCode(set, "image_key_not_in_wedding"),
                  ),
                  Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .delete("/registry/items/:itemId", async ({ weddingId, params, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              registryService.removeItem(weddingId, params.itemId).pipe(
                Effect.tap(() => Effect.sync(() => metricRegistryItemWrite("remove"))),
                Effect.map(() => ({ ok: true as const })),
                Effect.provideService(DbService, db),
                Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
                Effect.tapDefect(logDefect(weddingId)),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          })
          .post(
            "/registry/gifts/:kind/:giftId/thanked",
            async ({ weddingId, params, request, osnProfileId, set }) => {
              if (!weddingId || !osnProfileId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(SetThankedBody)(raw);
                  // The kind comes off the PATH, so it is validated as strictly
                  // as a body field would be — an unknown value must 400, never
                  // fall through to a table by coincidence.
                  const kind = yield* Schema.decodeUnknown(GiftKindSchema)(params.kind);
                  yield* registryService.setThanked({
                    weddingId,
                    kind,
                    giftId: params.giftId,
                    thanked: body.thanked,
                    actorOsnProfileId: osnProfileId,
                  });
                  yield* Effect.sync(() =>
                    metricRegistryGift(body.thanked ? "thanked" : "unthanked"),
                  );
                  return { ok: true as const };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("GiftNotInWedding", () => giftNotFound(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          ),
      ),
    );
