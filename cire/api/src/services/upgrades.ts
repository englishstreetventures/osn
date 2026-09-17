/**
 * Buying a capability.
 *
 * Everything below exists to stop one of two failures, both of which are
 * invisible in a happy-path test and expensive in production:
 *
 *  - **Charging twice for one entitlement.** A webhook can lag — seconds
 *    normally, days if the Worker answered 500 and Stripe is retrying. An
 *    organiser who paid, saw nothing unlock, and pressed Upgrade again must not
 *    be handed a second payment page.
 *  - **Taking money and granting nothing.** The settle path is four separate D1
 *    round trips with no transaction (D1's only atomic primitive is `batch()`),
 *    so every step has to be individually idempotent and ordered so that a
 *    crash between any two is healed by Stripe's next delivery rather than
 *    frozen by it.
 *
 * The orderings here are load-bearing. See the comments at each one.
 */

import { weddingEntitlements, weddingUpgradePurchases, weddings, platformSales } from "@cire/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitGroupedBatchesReturning, type Db, DbService, dbQuery } from "../db";
import { metricUpgradeCheckoutStarted, metricUpgradePurchaseSettled } from "../metrics";
import { entitlementService } from "./entitlements";
import type { StripeClient } from "./stripe";
import type { PurchasableEntitlement, UpgradeCatalogue } from "./upgrade-catalogue";

/** A purchase attempt that cannot proceed, and why. */
export class UpgradeConflict extends Data.TaggedError("UpgradeConflict")<{
  /**
   * `already_held` — nothing to sell. `processing` — an attempt is live or paid
   * but not yet settled, so the answer is "wait and poll", never "pay again".
   */
  readonly reason: "already_held" | "processing";
}> {}

/** The upgrade could not be sold here: no Stripe Price is configured for it. */
export class UpgradeUnavailable extends Data.TaggedError("UpgradeUnavailable")<{
  readonly entitlement: string;
}> {}

/** A write that failed for a reason that is not a conflict. */
export class UpgradeWriteError extends Data.TaggedError("UpgradeWriteError")<{
  readonly op: string;
  readonly reason: string;
}> {}

/** Stripe refused, so there is no payment page to send anyone to. */
export class UpgradeProviderError extends Data.TaggedError("UpgradeProviderError")<{
  readonly reason: string;
}> {}

/**
 * Tell a unique-constraint violation from any other write failure.
 *
 * A violation only ever reaches the error channel as a MESSAGE — both
 * bun:sqlite and D1 carry "UNIQUE constraint failed" — so the sniff is the only
 * way to distinguish it, and it must be narrow: a conflict on
 * `checkout_session_id` is a different situation from one on the partial
 * one-pending index, and anything that is not a conflict at all must surface as
 * a write error rather than a cheerful 409.
 *
 * MATCHED ON COLUMNS, NOT THE INDEX NAME. SQLite names the columns a conflict
 * was on and never the index that enforced it — a violation of the partial
 * one-pending index reports `UNIQUE constraint failed:
 * wedding_upgrade_purchases.wedding_id, wedding_upgrade_purchases.entitlement`.
 * Matching on the index name instead looks right, is what the index is called
 * in every other file, and can never fire: the caller then gets a 500 where the
 * contract says 409, and the organiser is told to try again on the one path
 * whose whole purpose is telling them to wait.
 */
export function upgradeConflictReason(message: string): "processing" | "session_taken" | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  // Checked first: a session conflict names that column alone, and the
  // one-pending pair must not swallow it.
  if (message.includes("checkout_session_id")) return "session_taken";
  return message.includes("wedding_id") && message.includes("entitlement") ? "processing" : null;
}

/**
 * How long a purchase row may sit with no Stripe session before another request
 * is allowed to close it.
 *
 * The window exists because a row is session-less for one Stripe round trip —
 * up to `STRIPE_CALL_TIMEOUT`, ten seconds — and closing another request's
 * in-flight row inside that window is a race: the first request then writes its
 * session id onto a closed row and hands the organiser a payment page whose
 * payment settles into a `failed` purchase. Nothing else in this repository
 * closes a row it does not own, and this is the condition under which it is
 * safe to.
 */
export const STALE_PENDING_MS = 60_000;

export interface StartPurchaseInput {
  weddingId: string;
  entitlement: PurchasableEntitlement;
  /** The owner who pressed Upgrade. Recorded, and used as the grant's actor. */
  actorProfileId: string;
  /**
   * Built from the purchase id, which does not exist until this call mints it —
   * so the caller hands over the shape of the URL rather than the URL. A plain
   * string here is how a `PURCHASE_ID` placeholder reaches Stripe and the
   * organiser returns to a page that cannot tell which purchase to poll.
   */
  successUrlFor: (purchaseId: string) => string;
  cancelUrl: string;
}

export interface StartPurchaseResult {
  purchaseId: string;
  url: string;
  /** True when this handed back a payment page that already existed. */
  reused: boolean;
}

type StartError = UpgradeConflict | UpgradeUnavailable | UpgradeWriteError | UpgradeProviderError;

export interface SettleInput {
  purchaseId: string;
  checkoutSessionId: string;
  paid: boolean;
  paidAmountMinor: number | null;
  paidCurrency: string | null;
  paymentIntentId: string | null;
}

/** What a settle attempt concluded. Mirrors the metric's bounded outcome set. */
export type SettleOutcome = "granted" | "replayed" | "unpaid" | "unknown";

export interface UpgradeServiceDeps {
  stripe: StripeClient;
  catalogue: UpgradeCatalogue;
  /** Injected so the staleness window is testable without waiting. */
  now?: () => number;
  newId?: (prefix: string) => string;
}

export function createUpgradeService(deps: UpgradeServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);

  /**
   * Both questions `startPurchase` opens with, in one statement.
   *
   * "Does the wedding already hold this?" and "is there a live attempt at it?"
   * are keyed on the same two arguments and neither produces the other's key,
   * so running them in sequence was an artefact of the `yield*` order rather
   * than a data dependency — two D1 round trips on every press where one does.
   * The `EXISTS` column is the `directory.ts` `inWedding` idiom.
   *
   * Anchored on `weddings` because the role gate has already proved that row
   * exists, and the LEFT JOIN can fan out to at most one row:
   * `wedding_upgrade_purchases_one_pending_uniq` makes a second pending row for
   * the same (wedding, entitlement) impossible.
   */
  const openingRead = (db: Db, weddingId: string, entitlement: PurchasableEntitlement) =>
    dbQuery(() =>
      db
        .select({
          held: sql<number>`EXISTS (SELECT 1 FROM ${weddingEntitlements} e WHERE e.wedding_id = ${weddingId} AND e.entitlement = ${entitlement})`,
          id: weddingUpgradePurchases.id,
          sessionId: weddingUpgradePurchases.checkoutSessionId,
          createdAt: weddingUpgradePurchases.createdAt,
        })
        .from(weddings)
        .leftJoin(
          weddingUpgradePurchases,
          and(
            eq(weddingUpgradePurchases.weddingId, weddings.id),
            eq(weddingUpgradePurchases.entitlement, entitlement),
            eq(weddingUpgradePurchases.status, "pending"),
          ),
        )
        .where(eq(weddings.id, weddingId))
        .all(),
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return {
          held: Boolean(row?.held),
          // A LEFT JOIN with no match leaves the purchase columns null, which
          // is "no live attempt" — distinct from "no wedding", which the gate
          // already ruled out.
          pending:
            row && row.id !== null && row.createdAt !== null
              ? { id: row.id, sessionId: row.sessionId, createdAt: row.createdAt }
              : null,
        };
      }),
    );

  /**
   * Close a pending row, guarded on the exact state it was observed in.
   *
   * The guard is what makes this safe to call on a row another request may own:
   * if that request has moved the row on since it was read, zero rows change
   * and nothing is stolen.
   */
  const closePending = (
    db: Db,
    purchaseId: string,
    expect: { sessionId: string } | { sessionId: null },
    status: "expired" | "failed",
  ) =>
    dbQuery(() =>
      db
        .update(weddingUpgradePurchases)
        .set({ status, updatedAt: new Date(now()) })
        .where(
          and(
            eq(weddingUpgradePurchases.id, purchaseId),
            eq(weddingUpgradePurchases.status, "pending"),
            expect.sessionId === null
              ? isNull(weddingUpgradePurchases.checkoutSessionId)
              : eq(weddingUpgradePurchases.checkoutSessionId, expect.sessionId),
          ),
        )
        .run(),
    );

  return {
    /**
     * Start (or resume) a purchase.
     *
     * The step order is the double-charge defence and is not rearrangeable.
     */
    startPurchase(
      input: StartPurchaseInput,
    ): Effect.Effect<StartPurchaseResult, StartError, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;

        // 1. One statement answers both opening questions — see `openingRead`.
        const opening = yield* openingRead(db, input.weddingId, input.entitlement);

        // Nothing to sell if the wedding already has it.
        if (opening.held) {
          metricUpgradeCheckoutStarted(input.entitlement, "already_held");
          return yield* Effect.fail(new UpgradeConflict({ reason: "already_held" }));
        }

        const priceId = deps.catalogue.priceIdFor(input.entitlement);
        if (priceId === null) {
          metricUpgradeCheckoutStarted(input.entitlement, "unconfigured");
          return yield* Effect.fail(new UpgradeUnavailable({ entitlement: input.entitlement }));
        }

        // 2. Resolve any live attempt BEFORE inserting. The partial unique
        //    index is the backstop behind this, not the control flow.
        const existing = opening.pending;
        if (existing !== null) {
          if (existing.sessionId !== null) {
            const probe = yield* deps.stripe
              .retrievePlatformCheckoutSession(existing.sessionId)
              .pipe(
                Effect.catch((e: unknown) =>
                  // A probe we could not run is not evidence the session is
                  // dead. Answering "processing" makes the organiser wait and
                  // retry; answering "expired" would mint a second payment page
                  // for a session that may well be open.
                  Effect.logError("upgrade session probe failed", {
                    purchaseId: existing.id,
                    reason: String(e),
                  }).pipe(Effect.as({ status: "unknown" as const })),
                ),
              );

            if (probe.status === "open") {
              metricUpgradeCheckoutStarted(input.entitlement, "reused");
              return { purchaseId: existing.id, url: probe.url, reused: true };
            }
            if (probe.status === "complete" || probe.status === "unknown") {
              // THE DOUBLE-CHARGE GUARD. A complete session means the money has
              // very likely moved and the webhook is merely late. Treating it as
              // dead — which a nullable probe result would force — closes a row
              // that was paid and sells the same entitlement again.
              metricUpgradeCheckoutStarted(input.entitlement, "processing");
              return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
            }
            // Only `expired` is safe to replace.
            yield* closePending(db, existing.id, { sessionId: existing.sessionId }, "expired");
          } else {
            // Session-less: either another request's in-flight attempt, or one
            // whose Stripe call died. Age is the only thing that tells them
            // apart, so inside the window this waits rather than stealing.
            const age = now() - existing.createdAt.getTime();
            if (age < STALE_PENDING_MS) {
              metricUpgradeCheckoutStarted(input.entitlement, "processing");
              return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
            }
            yield* closePending(db, existing.id, { sessionId: null }, "failed");
          }
        }

        // 3. Insert through tryPromise, not dbQuery: a partial-index conflict
        //    must land in the error channel as a 409, not as a defect (a 500).
        const purchaseId = newId("upg");
        const createdAt = new Date(now());
        yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              db
                .insert(weddingUpgradePurchases)
                .values({
                  id: purchaseId,
                  weddingId: input.weddingId,
                  entitlement: input.entitlement,
                  status: "pending",
                  createdByOsnProfileId: input.actorProfileId,
                  createdAt,
                  updatedAt: createdAt,
                })
                .run(),
            ),
          catch: (e) => {
            const message = String(e);
            const reason = upgradeConflictReason(message);
            // Lost the race to another press: somebody else's attempt is live.
            return reason === "processing"
              ? new UpgradeConflict({ reason: "processing" })
              : new UpgradeWriteError({ op: "insert-purchase", reason: message });
          },
        });

        // 4. Mint the session. On failure close our own row in the same request
        //    so the next press is not made to wait out the staleness window.
        const session = yield* deps.stripe
          .createPlatformCheckoutSession({
            priceId,
            successUrl: input.successUrlFor(purchaseId),
            cancelUrl: input.cancelUrl,
            clientReferenceId: purchaseId,
            metadata: { purchaseId },
            idempotencyKey: `cire-upgrade-${purchaseId}`,
          })
          .pipe(
            Effect.tapError(() => closePending(db, purchaseId, { sessionId: null }, "failed")),
            Effect.mapError((e) => new UpgradeProviderError({ reason: String(e) })),
          );

        // 5. Store the session id CONDITIONALLY and check the row count. Zero
        //    rows means somebody closed or claimed this row while Stripe was
        //    thinking, and handing out its URL would take a payment into a row
        //    that can never settle.
        const attached = yield* dbQuery(() =>
          db
            .update(weddingUpgradePurchases)
            .set({ checkoutSessionId: session.id, updatedAt: new Date(now()) })
            .where(
              and(
                eq(weddingUpgradePurchases.id, purchaseId),
                eq(weddingUpgradePurchases.status, "pending"),
                isNull(weddingUpgradePurchases.checkoutSessionId),
              ),
            )
            .returning({ id: weddingUpgradePurchases.id })
            .all(),
        );
        if (changedNone(attached)) {
          metricUpgradeCheckoutStarted(input.entitlement, "processing");
          return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
        }

        metricUpgradeCheckoutStarted(input.entitlement, "ok");
        return { purchaseId, url: session.url, reused: false };
      }).pipe(Effect.withSpan("cire.upgrade.startPurchase"));
    },

    /**
     * Settle a purchase from a verified webhook delivery. The ONLY place an
     * entitlement is granted from a payment.
     *
     * ORDER: verify → paid? → grant → sales → flip.
     *
     * THE INVARIANT, which matters more than the order: every delivery for a
     * paid session re-runs the grant and the sales insert, both idempotent, and
     * NOTHING short-circuits on "this row already reads succeeded". That state
     * is exactly what a delivery dying between the flip and the grant leaves
     * behind, so treating it as nothing-to-do would strand a customer who paid
     * with no entitlement and no further chance to get one.
     *
     * The order then makes the window as small as it can be — a crash after the
     * flip has nothing left to lose, and the conditional UPDATE is only ever
     * reporting whether THIS delivery was the first, never gating the work.
     */
    settlePurchase(input: SettleInput): Effect.Effect<SettleOutcome, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              id: weddingUpgradePurchases.id,
              weddingId: weddingUpgradePurchases.weddingId,
              entitlement: weddingUpgradePurchases.entitlement,
              status: weddingUpgradePurchases.status,
              sessionId: weddingUpgradePurchases.checkoutSessionId,
              buyer: weddingUpgradePurchases.createdByOsnProfileId,
            })
            .from(weddingUpgradePurchases)
            .where(eq(weddingUpgradePurchases.id, input.purchaseId))
            .all(),
        );
        const row = rows[0];
        if (row === undefined) {
          // Not ours. The platform endpoint is shared with whatever else this
          // Stripe account does, so this is an ordinary outcome, not an error.
          yield* Effect.logWarning("upgrade settle for an unknown purchase", {
            purchaseId: input.purchaseId,
          });
          return "unknown";
        }

        // A NULL session id is ADOPTION, not a mismatch: the row is
        // session-less for the window between minting the session and storing
        // its id, and the session is payable throughout. Rejecting it would
        // lock out a customer who paid.
        if (row.sessionId !== null && row.sessionId !== input.checkoutSessionId) {
          yield* Effect.logError("upgrade settle session mismatch", {
            purchaseId: input.purchaseId,
            heldSessionId: row.sessionId,
          });
          return "unknown";
        }

        const entitlement = row.entitlement as PurchasableEntitlement;

        if (!input.paid) {
          // Card-only sessions cannot complete unpaid, so this should never
          // fire — but granting on an unpaid session is the one mistake that
          // cannot be undone by a retry, so the check stays.
          metricUpgradePurchaseSettled(entitlement, "unpaid");
          return "unpaid";
        }

        // ONE ROUND TRIP for all three writes. D1 runs a batch atomically and
        // in statement order, so "grant, then sales, then flip" survives as
        // ordering INSIDE the batch — and a crash can no longer land between
        // the grant and the flip at all, which strengthens the invariant above
        // rather than weakening it. bun:sqlite has no `.batch()`, so the helper
        // chains them in the same order and the tests see no difference.
        const flipped = yield* dbQuery(() =>
          commitGroupedBatchesReturning(
            db,
            [
              // Idempotent on its own primary key.
              [
                entitlementService.grantStatement(db, row.weddingId, entitlement, {
                  source: "purchase",
                  // A webhook has no actor of its own; the buyer is the honest
                  // answer and is what the audit column is for.
                  grantedBy: row.buyer,
                  providerRef: input.checkoutSessionId,
                }),
              ],
              // Keyed on the purchase, so a redelivery writes one row.
              [
                db
                  .insert(platformSales)
                  .values({
                    id: newId("sal"),
                    purchaseId: row.id,
                    entitlement,
                    amountMinor: input.paidAmountMinor ?? 0,
                    currency: input.paidCurrency?.toUpperCase() ?? "",
                    settledAt: new Date(now()),
                  })
                  .onConflictDoNothing(),
              ],
            ],
            // The tail. Zero rows back means a previous delivery already did
            // all of the above.
            db
              .update(weddingUpgradePurchases)
              .set({
                status: "succeeded",
                checkoutSessionId: input.checkoutSessionId,
                paymentIntentId: input.paymentIntentId,
                amountMinor: input.paidAmountMinor,
                currency: input.paidCurrency?.toUpperCase() ?? null,
                updatedAt: new Date(now()),
              })
              .where(
                and(
                  eq(weddingUpgradePurchases.id, row.id),
                  eq(weddingUpgradePurchases.status, "pending"),
                ),
              )
              .returning({ id: weddingUpgradePurchases.id }),
          ),
        );

        const outcome: SettleOutcome = changedNone(flipped) ? "replayed" : "granted";
        metricUpgradePurchaseSettled(entitlement, outcome === "granted" ? "granted" : "replayed");
        return outcome;
      }).pipe(Effect.withSpan("cire.upgrade.settlePurchase"));
    },

    /** Close a purchase Stripe says is over. Only ever moves a `pending` row. */
    failPurchase(input: {
      purchaseId: string;
      checkoutSessionId: string;
      status: "failed" | "expired";
    }): Effect.Effect<"closed" | "ignored", never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const changed = yield* dbQuery(() =>
          db
            .update(weddingUpgradePurchases)
            .set({ status: input.status, updatedAt: new Date(now()) })
            .where(
              and(
                eq(weddingUpgradePurchases.id, input.purchaseId),
                eq(weddingUpgradePurchases.status, "pending"),
                eq(weddingUpgradePurchases.checkoutSessionId, input.checkoutSessionId),
              ),
            )
            // The metric's label comes back with the write. An expiry is the
            // ordinary end of an abandoned checkout, so re-reading the row we
            // just wrote would spend a round trip on every one of them.
            .returning({ entitlement: weddingUpgradePurchases.entitlement })
            .all(),
        );
        if (changedNone(changed)) return "ignored";
        const entitlement = (changed as { entitlement: string }[])[0]?.entitlement as
          | PurchasableEntitlement
          | undefined;
        if (entitlement) {
          metricUpgradePurchaseSettled(
            entitlement,
            input.status === "failed" ? "failed" : "expired",
          );
        }
        return "closed";
      }).pipe(Effect.withSpan("cire.upgrade.failPurchase"));
    },

    /**
     * A purchase's state, for the page the organiser returns to. Scoped to the
     * wedding, so an id belonging to another wedding is simply not found.
     */
    purchaseStatus(
      weddingId: string,
      purchaseId: string,
    ): Effect.Effect<{ status: string; entitlement: string } | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              status: weddingUpgradePurchases.status,
              entitlement: weddingUpgradePurchases.entitlement,
            })
            .from(weddingUpgradePurchases)
            .where(
              and(
                eq(weddingUpgradePurchases.id, purchaseId),
                eq(weddingUpgradePurchases.weddingId, weddingId),
              ),
            )
            .all(),
        );
        return rows[0] ?? null;
      }).pipe(Effect.withSpan("cire.upgrade.purchaseStatus"));
    },
  };
}

/**
 * Did a guarded write match nothing?
 *
 * Reads the ROWS BACK (`.returning(...).all()`) rather than a driver's row
 * count. The count is spelled differently by each driver — bun:sqlite puts it
 * on `.changes`, D1 under `meta.changes` — and the whole test suite runs on
 * bun:sqlite, so a wrong reading of D1's shape would pass every test here and
 * fail closed in production: every settle reporting `replayed` instead of
 * `granted`, every session attach 409ing. Returned rows are the same array on
 * both, which removes the divergence rather than testing for it. Same idiom as
 * `settleContribution`'s adoption guard in `registry.ts`.
 */
function changedNone(result: unknown): boolean {
  return !Array.isArray(result) || result.length === 0;
}

export type UpgradeService = ReturnType<typeof createUpgradeService>;
