/**
 * Buying a plan tier.
 *
 * Everything below exists to stop one of two failures, both of which are
 * invisible in a happy-path test and expensive in production:
 *
 *  - **Charging twice for one tier.** A webhook can lag — seconds
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

import { weddingUpgradePurchases, weddings, platformSales } from "@cire/db";
import { and, eq, gt, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitGroupedBatchesReturning, type Db, DbService, dbQuery, driverErrorText } from "../db";
import { metricUpgradeCheckoutStarted, metricUpgradePurchaseSettled } from "../metrics";
import type { StripeClient } from "./stripe";
import {
  normaliseTier,
  PAID_TIERS,
  type PaidTier,
  type Tier,
  tierAtLeast,
  tierService,
} from "./tiers";
import type { UpgradeCatalogue } from "./upgrade-catalogue";

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
  readonly tier: PaidTier;
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
 * Tell a unique-constraint violation from any other write failure, in the text
 * `driverErrorText` reads from the failed write.
 *
 * A violation only ever reaches the error channel as text — on bun:sqlite as
 * the error's message, on D1 as the message of its `cause` — so the sniff is
 * the only way to distinguish it, and it must be narrow: a conflict on
 * `checkout_session_id` is a different situation from one on the partial
 * one-pending index, and anything that is not a conflict at all must surface as
 * a write error rather than a cheerful 409.
 *
 * MATCHED ON COLUMNS, NOT THE INDEX NAME. SQLite names the columns a conflict
 * was on and never the index that enforced it — a violation of the partial
 * one-pending index, which is on the wedding alone, reports `UNIQUE constraint
 * failed: wedding_upgrade_purchases.wedding_id`. Matching on the index name
 * instead looks right, is what the index is called in every other file, and
 * can never fire: the caller then gets a 500 where the contract says 409, and
 * the organiser is told to try again on the one path whose whole purpose is
 * telling them to wait.
 *
 * AND ON `table.column`, NEVER A BARE COLUMN. On D1 the text also holds
 * drizzle's `Failed query: <statement>`, and the purchase INSERT names every
 * column, `checkout_session_id` included, whatever the conflict was on. Drizzle
 * quotes each name, so the unquoted `table.column` appears only in the
 * database's reason.
 */
export function upgradeConflictReason(message: string): "processing" | "session_taken" | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  // Checked first: a session conflict names that column alone, and the
  // one-pending index must not swallow it.
  if (message.includes("wedding_upgrade_purchases.checkout_session_id")) return "session_taken";
  return message.includes("wedding_upgrade_purchases.wedding_id") ? "processing" : null;
}

/**
 * The tier a purchase row's product grants, or `null` when it names none.
 *
 * `gold` and `crimson` are the products sold today. The legacy entitlement keys
 * are rows written before tiers, and each grants the tier that replaced it — a
 * paid `vendors` session is Crimson, a paid `registry` one Gold — so a session
 * opened before the switch still settles into what its money now buys.
 */
export function tierForProduct(product: string): PaidTier | null {
  switch (product) {
    case "gold":
    case "registry":
    case "capacity_500":
      return "gold";
    case "crimson":
    case "vendors":
    case "capacity_1000":
      return "crimson";
    default:
      return null;
  }
}

/** Every product {@link tierForProduct} maps to a tier. */
const TIER_PRODUCTS = ["gold", "registry", "capacity_500", "crimson", "vendors", "capacity_1000"];

/**
 * The products whose purchase granted a tier ranked above `tier` — what a
 * wedding lowered to `tier` no longer holds. Lowering a wedding marks its paid
 * purchases of these `refunded`.
 */
export function productsAbove(tier: Tier): string[] {
  return TIER_PRODUCTS.filter((product) => {
    const granted = tierForProduct(product);
    return granted !== null && !tierAtLeast(tier, granted);
  });
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

/**
 * How long a Checkout Session stays payable. `createPlatformCheckoutSession`
 * sets no `expires_at`, so Stripe's default of a day applies to every session
 * this product has opened.
 */
export const CHECKOUT_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface StartPurchaseInput {
  weddingId: string;
  tier: PaidTier;
  /** The owner who pressed Upgrade. Recorded on the purchase row. */
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
export type SettleOutcome = "granted" | "replayed" | "unpaid" | "unknown" | "mismatch" | "refunded";

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
   * Everything `startPurchase` opens with, in one statement: the tier the
   * wedding is on now, the purchase of it in flight if there is one, and any
   * legacy per-module page whose row the tier migration expired.
   *
   * Anchored on `weddings` because the role gate has already proved that row
   * exists. The LEFT JOIN fans out to at most one `pending` row —
   * `wedding_upgrade_purchases_one_pending_uniq` allows one per wedding,
   * whatever it buys — plus those legacy rows, a handful at most.
   *
   * A LEGACY ROW is one the migration marked `expired` without closing its
   * Stripe session, which stays payable for a day after it opened. It is read
   * here while it may still be payable, so the double-charge guard sees every
   * page that could still take money. Removed by englishstventures/osn#1315.
   */
  const openingRead = (db: Db, weddingId: string) =>
    dbQuery(() =>
      db
        .select({
          tier: weddings.tier,
          id: weddingUpgradePurchases.id,
          status: weddingUpgradePurchases.status,
          product: weddingUpgradePurchases.entitlement,
          fromTier: weddingUpgradePurchases.fromTier,
          sessionId: weddingUpgradePurchases.checkoutSessionId,
          createdAt: weddingUpgradePurchases.createdAt,
        })
        .from(weddings)
        .leftJoin(
          weddingUpgradePurchases,
          and(
            eq(weddingUpgradePurchases.weddingId, weddings.id),
            or(
              eq(weddingUpgradePurchases.status, "pending"),
              and(
                eq(weddingUpgradePurchases.status, "expired"),
                // oxlint-disable-next-line house/no-unbounded-in-array -- PAID_TIERS is a two-member tuple in ./tiers
                notInArray(weddingUpgradePurchases.entitlement, [...PAID_TIERS]),
                isNotNull(weddingUpgradePurchases.checkoutSessionId),
                gt(
                  weddingUpgradePurchases.createdAt,
                  new Date(now() - CHECKOUT_SESSION_LIFETIME_MS),
                ),
              ),
            ),
          ),
        )
        .where(eq(weddings.id, weddingId))
        .all(),
    ).pipe(
      Effect.map((rows) => {
        // A LEFT JOIN with no match leaves the purchase columns null, which
        // is "no live attempt" — distinct from "no wedding", which the gate
        // already ruled out.
        const pendingRow = rows.find((r) => r.status === "pending");
        return {
          tier: normaliseTier(rows[0]?.tier),
          pending:
            pendingRow &&
            pendingRow.id !== null &&
            pendingRow.product !== null &&
            pendingRow.createdAt !== null
              ? {
                  id: pendingRow.id,
                  product: pendingRow.product,
                  fromTier: pendingRow.fromTier,
                  sessionId: pendingRow.sessionId,
                  createdAt: pendingRow.createdAt,
                }
              : null,
          legacyPages: rows.flatMap((r) =>
            r.status === "expired" && r.id !== null && r.sessionId !== null
              ? [{ id: r.id, sessionId: r.sessionId }]
              : [],
          ),
        };
      }),
    );

  /**
   * Ask Stripe where a session has got to. A probe that could not run is not
   * evidence the session is dead, so it reads `unknown` — which every caller
   * answers by waiting, never by minting a second payment page.
   */
  const probeSession = (purchaseId: string, sessionId: string) =>
    deps.stripe.retrievePlatformCheckoutSession(sessionId).pipe(
      Effect.catch((e: unknown) =>
        Effect.logError("upgrade session probe failed", {
          purchaseId,
          reason: String(e),
        }).pipe(Effect.as({ status: "unknown" as const })),
      ),
    );

  /**
   * Close an open session at Stripe so it can no longer be paid. `false` when
   * Stripe refused, which means it may have completed in the meantime.
   */
  const expireAtStripe = (purchaseId: string, sessionId: string) =>
    deps.stripe.expirePlatformCheckoutSession(sessionId).pipe(
      Effect.as(true),
      Effect.catch((e: unknown) =>
        Effect.logError("upgrade session expire failed", {
          purchaseId,
          reason: String(e),
        }).pipe(Effect.as(false)),
      ),
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

  /**
   * Mark a purchase whose own session was paid but not granted, and record
   * what arrived. Moves only a row still open (`pending` or `expired`) and
   * still holding this session, so a replay changes nothing.
   */
  const recordMismatch = (db: Db, purchaseId: string, input: SettleInput) =>
    dbQuery(() =>
      db
        .update(weddingUpgradePurchases)
        .set({
          status: "mismatch",
          paymentIntentId: input.paymentIntentId,
          amountMinor: input.paidAmountMinor,
          currency: input.paidCurrency?.toUpperCase() ?? null,
          updatedAt: new Date(now()),
        })
        .where(
          and(
            eq(weddingUpgradePurchases.id, purchaseId),
            inArray(weddingUpgradePurchases.status, ["pending", "expired"]),
            eq(weddingUpgradePurchases.checkoutSessionId, input.checkoutSessionId),
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

        // 1. One statement answers the opening questions — see `openingRead`.
        const opening = yield* openingRead(db, input.weddingId);
        const from = opening.tier;
        const started = (result: Parameters<typeof metricUpgradeCheckoutStarted>[2]) =>
          metricUpgradeCheckoutStarted(input.tier, from, result);

        // Nothing to sell if the wedding is already there, or past it.
        if (tierAtLeast(from, input.tier)) {
          started("already_held");
          return yield* Effect.fail(new UpgradeConflict({ reason: "already_held" }));
        }

        // The Price this press would charge, with its amount: the purchase
        // records both, and settle grants only for a payment of exactly that.
        // Read before anything is written or sent to Stripe, so a refusal
        // leaves nothing behind.
        const quote = yield* deps.catalogue.quote(input.tier, from).pipe(
          Effect.tapError(() => Effect.sync(() => started("error"))),
          Effect.mapError((e) => new UpgradeProviderError({ reason: String(e) })),
        );
        if (quote === null) {
          started("unconfigured");
          return yield* Effect.fail(new UpgradeUnavailable({ tier: input.tier }));
        }

        // 2. Close every legacy page that may still be payable, at Stripe,
        //    before anything else: its row already reads `expired`, so the
        //    pending-row logic below would never see it. Paid but unsettled,
        //    or not closable, means wait. Removed by englishstventures/osn#1315.
        for (const legacy of opening.legacyPages) {
          const probe = yield* probeSession(legacy.id, legacy.sessionId);
          const closed =
            probe.status === "expired" ||
            (probe.status === "open" && (yield* expireAtStripe(legacy.id, legacy.sessionId)));
          if (!closed) {
            started("processing");
            return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
          }
        }

        // 3. Resolve any live attempt BEFORE inserting. The partial unique
        //    index is the backstop behind this, not the control flow.
        const existing = opening.pending;
        if (existing !== null) {
          // The same product at the same Price is the same purchase: its open
          // page is this press's page too. Anything else — the other tier, the
          // same tier priced from a tier the wedding has since left, or a
          // legacy per-module row — must never be handed out for this press,
          // or a Crimson click lands on a Gold payment page.
          const samePurchase = existing.product === input.tier && existing.fromTier === from;

          if (existing.sessionId !== null) {
            // A probe that could not run answers `unknown`: waiting and
            // retrying is safe, while reading it as expired would mint a
            // second payment page for a session that may well be open.
            const probe = yield* probeSession(existing.id, existing.sessionId);

            if (probe.status === "complete" || probe.status === "unknown") {
              // THE DOUBLE-CHARGE GUARD. A complete session means the money has
              // very likely moved and the webhook is merely late. Treating it as
              // dead — which a nullable probe result would force — closes a row
              // that was paid and sells again. The same holds when the paid
              // session bought a different tier: the wedding's tier is about to
              // move, and the price of this press with it.
              started("processing");
              return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
            }
            if (probe.status === "open") {
              if (samePurchase) {
                started("reused");
                return { purchaseId: existing.id, url: probe.url, reused: true };
              }
              // Another product's page is still payable. Close it at Stripe
              // before opening this one, so the two can never both be paid. A
              // refusal means it may have completed in the meantime — wait.
              const expired = yield* expireAtStripe(existing.id, existing.sessionId);
              if (!expired) {
                started("processing");
                return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
              }
            }
            // `expired` from the probe, or expired just now by us: safe to
            // replace.
            yield* closePending(db, existing.id, { sessionId: existing.sessionId }, "expired");
          } else {
            // Session-less: either another request's in-flight attempt, or one
            // whose Stripe call died. Age is the only thing that tells them
            // apart, so inside the window this waits rather than stealing —
            // whatever that attempt is buying.
            const age = now() - existing.createdAt.getTime();
            if (age < STALE_PENDING_MS) {
              started("processing");
              return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
            }
            yield* closePending(db, existing.id, { sessionId: null }, "failed");
          }
        }

        // 4. Insert through tryPromise, not dbQuery: a partial-index conflict
        //    must land in the error channel as a 409, not as a defect (a 500).
        //    `from` ranks below `input.tier`, so it is Ivory or Gold.
        const fromTier = from === "gold" ? "gold" : "ivory";
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
                  entitlement: input.tier,
                  fromTier,
                  priceId: quote.priceId,
                  priceAmountMinor: quote.amountMinor,
                  priceCurrency: quote.currency,
                  status: "pending",
                  createdByOsnProfileId: input.actorProfileId,
                  createdAt,
                  updatedAt: createdAt,
                })
                .run(),
            ),
          catch: (e) =>
            // Lost the race to another press: somebody else's attempt is live.
            // The logged reason is the statement alone: the database's own
            // text can quote a bound value (D1 names the value it could not bind).
            upgradeConflictReason(driverErrorText(e)) === "processing"
              ? new UpgradeConflict({ reason: "processing" })
              : new UpgradeWriteError({ op: "insert-purchase", reason: String(e) }),
        }).pipe(
          Effect.tapError((err) =>
            err._tag === "UpgradeConflict" ? Effect.sync(() => started("processing")) : Effect.void,
          ),
        );

        // 5. Mint the session. On failure close our own row in the same request
        //    so the next press is not made to wait out the staleness window.
        const session = yield* deps.stripe
          .createPlatformCheckoutSession({
            priceId: quote.priceId,
            successUrl: input.successUrlFor(purchaseId),
            cancelUrl: input.cancelUrl,
            clientReferenceId: purchaseId,
            metadata: { purchaseId },
            idempotencyKey: `cire-upgrade-${purchaseId}`,
          })
          .pipe(
            Effect.tapError(() =>
              closePending(db, purchaseId, { sessionId: null }, "failed").pipe(
                Effect.tap(() => Effect.sync(() => started("error"))),
              ),
            ),
            Effect.mapError((e) => new UpgradeProviderError({ reason: String(e) })),
          );

        // 6. Store the session id CONDITIONALLY and check the row count. Zero
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
          started("processing");
          return yield* Effect.fail(new UpgradeConflict({ reason: "processing" }));
        }

        started("ok");
        return { purchaseId, url: session.url, reused: false };
      }).pipe(Effect.withSpan("cire.upgrade.startPurchase"));
    },

    /**
     * Settle a purchase from a verified webhook delivery. The ONLY place a tier
     * is granted from a payment.
     *
     * ORDER: verify → paid? → grant → sales → flip.
     *
     * THE INVARIANT, which matters more than the order: every delivery for a
     * paid session re-runs the grant and the sales insert, both idempotent, and
     * NOTHING short-circuits on "this row already reads succeeded". That state
     * is exactly what a delivery dying between the flip and the grant leaves
     * behind, so treating it as nothing-to-do would strand a customer who paid
     * with no tier and no further chance to get one.
     *
     * The order then makes the window as small as it can be — a crash after the
     * flip has nothing left to lose, and the conditional UPDATE is only ever
     * reporting whether THIS delivery was the first, never gating the work.
     *
     * A paid purchase whose product maps to no tier is a DEFECT, not an answer:
     * the delivery is answered 500 so Stripe keeps retrying it while someone
     * looks, because a 2xx would end the only record that money arrived for
     * nothing.
     *
     * A grant is bound to the payment the purchase sold. The purchase id comes
     * from `client_reference_id`, which any payment on this Stripe account can
     * carry, so the amount and currency paid must be the Price the row
     * recorded when it opened; anything else is a `mismatch` — logged, counted,
     * nothing granted, and acknowledged, since a retry cannot change what was
     * paid. A row's own session that paid the wrong amount marks the row
     * `mismatch` with what arrived, so the money is findable.
     *
     * Two states on the row stop a grant that the invariant above would
     * otherwise replay. A `refunded` purchase — one an operator took back with
     * `grant-tier.ts --lower` — grants nothing however often its payment is
     * redelivered. And a purchase priced as an upgrade from a tier
     * (`from_tier`) grants only while the wedding still holds that tier: a
     * from-Gold Crimson paid after the wedding was lowered to Ivory is a
     * `mismatch`. A paying customer's replay is untouched by either: after a
     * grant the wedding ranks at or above `from_tier`, and nothing but an
     * operator writes `refunded`.
     */
    settlePurchase(input: SettleInput): Effect.Effect<SettleOutcome, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              id: weddingUpgradePurchases.id,
              weddingId: weddingUpgradePurchases.weddingId,
              product: weddingUpgradePurchases.entitlement,
              status: weddingUpgradePurchases.status,
              sessionId: weddingUpgradePurchases.checkoutSessionId,
              priceAmountMinor: weddingUpgradePurchases.priceAmountMinor,
              priceCurrency: weddingUpgradePurchases.priceCurrency,
              fromTier: weddingUpgradePurchases.fromTier,
              // The tier the wedding holds now, in the same read, for the
              // from-tier rule below.
              weddingTier: weddings.tier,
            })
            .from(weddingUpgradePurchases)
            .leftJoin(weddings, eq(weddings.id, weddingUpgradePurchases.weddingId))
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

        if (row.sessionId !== null && row.sessionId !== input.checkoutSessionId) {
          yield* Effect.logError("upgrade settle session mismatch", {
            purchaseId: input.purchaseId,
            heldSessionId: row.sessionId,
          });
          return "unknown";
        }

        // A NULL session id is ADOPTION: the row is session-less for the
        // window between minting its session and storing the id, and the
        // session is payable throughout, so rejecting it would lock out a
        // customer who paid. That window exists only while the row is
        // `pending`, and only a row that recorded its Price can hold the
        // payment to an amount — anything else adopts nothing.
        const adopting = row.sessionId === null;
        if (
          adopting &&
          (row.status !== "pending" || row.priceAmountMinor === null || row.priceCurrency === null)
        ) {
          yield* Effect.logError("upgrade settle refused adoption", {
            purchaseId: row.id,
            status: row.status,
            checkoutSessionId: input.checkoutSessionId,
          });
          return "unknown";
        }

        const tier = tierForProduct(row.product);

        if (row.status === "refunded") {
          metricUpgradePurchaseSettled(tier ?? "unmapped", "refunded");
          yield* Effect.logWarning("upgrade settle for a refunded purchase", {
            purchaseId: row.id,
          });
          return "refunded";
        }

        if (!input.paid) {
          // Card-only sessions cannot complete unpaid, so this should never
          // fire — but granting on an unpaid session is the one mistake that
          // cannot be undone by a retry, so the check stays.
          metricUpgradePurchaseSettled(tier ?? "unmapped", "unpaid");
          return "unpaid";
        }

        if (tier === null) {
          metricUpgradePurchaseSettled("unmapped", "defect");
          yield* Effect.logError("upgrade settle unmappable product", {
            purchaseId: row.id,
            product: row.product,
          });
          return yield* Effect.die(new Error("upgrade purchase names no tier"));
        }

        // A row written before purchases recorded their Price has no amount to
        // hold the payment to; it is settled only by the session it already
        // holds, which the adoption rule above guarantees.
        const paidCurrency = input.paidCurrency?.toUpperCase() ?? null;
        if (
          row.priceAmountMinor !== null &&
          row.priceCurrency !== null &&
          (input.paidAmountMinor !== row.priceAmountMinor || paidCurrency !== row.priceCurrency)
        ) {
          metricUpgradePurchaseSettled(tier, "mismatch");
          yield* Effect.logError("upgrade settle amount mismatch", {
            purchaseId: row.id,
            checkoutSessionId: input.checkoutSessionId,
            priceAmountMinor: row.priceAmountMinor,
            priceCurrency: row.priceCurrency,
            paidAmountMinor: input.paidAmountMinor,
            paidCurrency,
          });
          // Only the row's own session marks the row. A payment naming a
          // session-less row is not that row's session, and the attempt that
          // owns the row is left to finish.
          if (!adopting) yield* recordMismatch(db, row.id, input);
          return "mismatch";
        }

        // Priced as an upgrade from a tier the wedding no longer holds: the
        // payment bought this tier for a wedding on `from_tier`, which this
        // one has since been lowered from. The grant statement below carries
        // the same condition, so the rule holds even against a lowering that
        // lands between this read and the batch.
        const weddingTier = normaliseTier(row.weddingTier);
        if (row.fromTier !== null && !tierAtLeast(weddingTier, row.fromTier)) {
          metricUpgradePurchaseSettled(tier, "mismatch");
          yield* Effect.logError("upgrade settle from a tier the wedding no longer holds", {
            purchaseId: row.id,
            checkoutSessionId: input.checkoutSessionId,
            fromTier: row.fromTier,
            weddingTier,
          });
          if (!adopting) yield* recordMismatch(db, row.id, input);
          return "mismatch";
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
              // Only ever raises the tier, so a replay — or a late delivery for
              // a lower tier than the wedding has since reached — changes
              // nothing.
              [
                tierService.tierGrantStatement(
                  db,
                  row.weddingId,
                  tier,
                  {
                    source: "purchase",
                    // A webhook has no actor of its own. The purchase names the
                    // buyer, so the grant names the purchase.
                    grantedBy: `stripe:${row.id}`,
                  },
                  row.fromTier ?? undefined,
                ),
              ],
              // Keyed on the purchase, so a redelivery writes one row.
              [
                db
                  .insert(platformSales)
                  .values({
                    id: newId("sal"),
                    purchaseId: row.id,
                    entitlement: row.product,
                    amountMinor: input.paidAmountMinor ?? 0,
                    currency: input.paidCurrency?.toUpperCase() ?? "",
                    settledAt: new Date(now()),
                  })
                  .onConflictDoNothing(),
              ],
            ],
            // The tail. Zero rows back means a previous delivery already did
            // all of the above. An `expired` row flips too: a session can be
            // paid in the moment before it is expired, and the money is then
            // as real as any other.
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
                  inArray(weddingUpgradePurchases.status, ["pending", "expired"]),
                ),
              )
              .returning({ id: weddingUpgradePurchases.id }),
          ),
        );

        const outcome: SettleOutcome = changedNone(flipped) ? "replayed" : "granted";
        metricUpgradePurchaseSettled(tier, outcome === "granted" ? "granted" : "replayed");
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
            .returning({ product: weddingUpgradePurchases.entitlement })
            .all(),
        );
        if (changedNone(changed)) return "ignored";
        const product = (changed as { product: string }[])[0]?.product;
        if (product !== undefined) {
          metricUpgradePurchaseSettled(
            tierForProduct(product) ?? "unmapped",
            input.status === "failed" ? "failed" : "expired",
          );
        }
        return "closed";
      }).pipe(Effect.withSpan("cire.upgrade.failPurchase"));
    },

    /**
     * A purchase's state, for the page the organiser returns to. Scoped to the
     * wedding, so an id belonging to another wedding is simply not found.
     * `tier` is what the purchase buys — `null` only for a legacy product that
     * maps to no tier.
     */
    purchaseStatus(
      weddingId: string,
      purchaseId: string,
    ): Effect.Effect<{ status: string; tier: PaidTier | null } | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              status: weddingUpgradePurchases.status,
              product: weddingUpgradePurchases.entitlement,
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
        const row = rows[0];
        return row ? { status: row.status, tier: tierForProduct(row.product) } : null;
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
