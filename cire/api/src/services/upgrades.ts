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
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, type Db, DbService, dbQuery, driverErrorText } from "../db";
import { metricUpgradeCheckoutStarted, metricUpgradePurchaseSettled } from "../metrics";
import type { StripeClient } from "./stripe";
import {
  isTier,
  normaliseTier,
  PAID_TIERS,
  type PaidTier,
  type Tier,
  TIERS,
  tierAtLeast,
  tierService,
  tiersBelow,
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
class UpgradeUnavailable extends Data.TaggedError("UpgradeUnavailable")<{
  readonly tier: PaidTier;
}> {}

/** A write that failed for a reason that is not a conflict. */
class UpgradeWriteError extends Data.TaggedError("UpgradeWriteError")<{
  readonly op: string;
  readonly reason: string;
}> {}

/** Stripe refused, so there is no payment page to send anyone to. */
class UpgradeProviderError extends Data.TaggedError("UpgradeProviderError")<{
  readonly reason: string;
}> {}

/**
 * The statuses a payment for the row's own session can still settle from.
 * `expired` and `failed` because a session can be paid in the moment before
 * the row is closed, and the money is as real as any other; `mismatch` is a
 * row an earlier release refused, which a resend of its payment now settles.
 */
const OPEN_STATUSES = ["pending", "expired", "failed", "mismatch"] as const;

const isOpen = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);

/** Why a paid checkout of ours cannot upgrade the wedding. */
type RefundReason =
  | "no_tier"
  | "wedding_not_live"
  | "unknown_tier"
  | "not_from_tier"
  | "already_held";

/**
 * Whether a paid session of the row's own must be refunded rather than
 * granted, and why — `null` when it grants.
 *
 * `not_from_tier` is a purchase priced as an upgrade from a tier
 * (`from_tier`, the from-Gold Crimson Price) for a wedding that no longer holds
 * that tier: an operator lowered it while the page was open. Granting would
 * sell the full tier at the difference's price, so it is refunded instead.
 *
 * `already_held` is a wedding at or above the tier that did not get there by
 * this purchase: an operator's comp or an unlock code raised it while the page
 * was open, so the payment bought nothing.
 *
 * A wedding this purchase itself raised (`tier_granted_by` names it) is a
 * grant whose flip never landed, and settles as a grant.
 */
function refundReason(
  row: {
    id: string;
    fromTier: "ivory" | "gold" | null;
    weddingLive: number | null;
    weddingTier: string | null;
    weddingGrantedBy: string | null;
  },
  tier: PaidTier | null,
): RefundReason | null {
  if (tier === null) return "no_tier";
  if (!row.weddingLive) return "wedding_not_live";
  // A tier no build knows — only hand-written SQL makes one — is one the grant
  // statement cannot raise from, so the payment is given back.
  if (!isTier(row.weddingTier)) return "unknown_tier";
  if (row.weddingGrantedBy === `stripe:${row.id}`) return null;
  const held = normaliseTier(row.weddingTier);
  if (row.fromTier !== null && !tierAtLeast(held, row.fromTier)) return "not_from_tier";
  if (tierAtLeast(held, tier)) return "already_held";
  return null;
}

/**
 * The wedding still holds the tier a purchase was priced from — `undefined`
 * (no condition) for one priced from nothing. Two values at most.
 */
function fromTierHeld(fromTier: "ivory" | "gold" | null): SQL | undefined {
  if (fromTier === null) return undefined;
  const held = TIERS.filter((t) => tierAtLeast(t, fromTier));
  // oxlint-disable-next-line house/no-unbounded-in-array -- at most three values: drawn from TIERS
  return inArray(weddings.tier, held);
}

/** The status a batched read-back found, or `undefined` for no row. */
function readBack(result: unknown): string | undefined {
  return Array.isArray(result) ? (result[0] as { status?: string } | undefined)?.status : undefined;
}

/**
 * How many purchases one daily reconciliation reads. Each costs at most two
 * Stripe calls and three D1 statements inside the cron's shared invocation
 * (`wiki/shared/free-tier-limits.md`), and the set is empty on any day every
 * webhook landed.
 */
export const RECONCILE_PER_RUN = 2;

/**
 * How long, from the purchase's creation, the daily reconciliation keeps
 * asking Stripe for a refund it refuses before it stops and hands the refund
 * to a person (`refund_failed`). The purge holds the wedding either way until
 * a person marks the purchase `refunded` (`purgeHeld` in
 * `maintenance-sweeps.ts`).
 */
export const REFUND_GIVE_UP_MS = 13 * 24 * 60 * 60 * 1000;

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
const CHECKOUT_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface StartPurchaseInput {
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

interface SettleInput {
  purchaseId: string;
  checkoutSessionId: string;
  paid: boolean;
  paidAmountMinor: number | null;
  paidCurrency: string | null;
  paymentIntentId: string | null;
}

/** What a settle attempt concluded. Mirrors the metric's bounded outcome set. */
type SettleOutcome =
  | "granted"
  | "replayed"
  | "unpaid"
  | "unknown"
  | "refunded"
  | "auto_refunded"
  // A refund cire decided on that Stripe has not taken: refused (and counted),
  // or handed to a person; or still running under another delivery's key.
  | "refund_failed"
  | "refunding";

/** The purchase a settle is about, as the steps after its first read need it. */
interface PurchaseRef {
  id: string;
  weddingId: string;
  tier: PaidTier | null;
  label: PaidTier | "unmapped";
  paymentIntentId: string | null;
  fromTier: "ivory" | "gold" | null;
}

interface UpgradeServiceDeps {
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
   * page that could still take money. Removed by englishstreetventures/osn#1315.
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
   * The purchase reads `status` now, as a condition for a statement batched
   * beside the write that moves it. The grant and the sales row follow the
   * flip this way, so a purchase a concurrent delivery has decided to refund
   * never raises a tier or records a sale, whatever order the two land in.
   */
  const purchaseReads = (purchaseId: string, status: string): SQL =>
    sql`EXISTS (SELECT 1 FROM ${weddingUpgradePurchases} WHERE ${weddingUpgradePurchases.id} = ${purchaseId} AND ${weddingUpgradePurchases.status} = ${status})`;

  /**
   * The wedding can take this purchase's grant now: it is live, and it is
   * below the tier and still holds the tier the purchase was priced from, or
   * was raised to it by this purchase. The grant batch's
   * flip carries it, so the read's decision still holds when the flip lands.
   */
  const grantable = (purchase: PurchaseRef, tier: PaidTier): SQL => {
    // oxlint-disable-next-line house/no-unbounded-in-array -- at most two values: drawn from TIERS, below `tier`
    const below = and(inArray(weddings.tier, tiersBelow(tier)), fromTierHeld(purchase.fromTier));
    return sql`EXISTS (SELECT 1 FROM ${weddings} WHERE ${weddings.id} = ${purchase.weddingId} AND ${weddings.deletedAt} IS NULL AND (${below} OR ${weddings.tierGrantedBy} = ${`stripe:${purchase.id}`}))`;
  };

  /**
   * A payment intent to record: the one Stripe named, else whatever the row
   * already holds, so a delivery that names none never erases one.
   */
  const paymentIntentOr = (paymentIntentId: string | null): SQL =>
    sql`coalesce(${paymentIntentId}, ${weddingUpgradePurchases.paymentIntentId})`;

  /** What a delivery says arrived, as the row records it. */
  const arrived = (input: SettleInput) => ({
    amountMinor: input.paidAmountMinor,
    currency: input.paidCurrency?.toUpperCase() ?? null,
    paymentIntentId: paymentIntentOr(input.paymentIntentId),
  });

  /** The row's status now, from a read batched after a guarded write. */
  const statusReadBack = (db: Db, purchaseId: string) =>
    db
      .select({ status: weddingUpgradePurchases.status })
      .from(weddingUpgradePurchases)
      .where(eq(weddingUpgradePurchases.id, purchaseId));

  /**
   * Move a `refunding` row on, and say whether this call moved it. A refund
   * Stripe accepted (`auto_refunded` with its id) also moves a row handed to a
   * person that holds no refund id: the give-up can land while a refund that
   * ran at Stripe is still on its way back, and that refund outranks it. A
   * bank's failure keeps its refund id, so it is never overwritten here.
   */
  const leaveRefunding = (
    db: Db,
    purchaseId: string,
    set: { status: "auto_refunded" | "refunded" | "refund_failed"; refundId?: string },
  ) =>
    dbQuery(() =>
      db
        .update(weddingUpgradePurchases)
        .set({ ...set, updatedAt: new Date(now()) })
        .where(
          and(
            eq(weddingUpgradePurchases.id, purchaseId),
            set.status === "auto_refunded"
              ? or(
                  eq(weddingUpgradePurchases.status, "refunding"),
                  and(
                    eq(weddingUpgradePurchases.status, "refund_failed"),
                    isNull(weddingUpgradePurchases.refundId),
                  ),
                )
              : eq(weddingUpgradePurchases.status, "refunding"),
          ),
        )
        .returning({ id: weddingUpgradePurchases.id })
        .all(),
    ).pipe(Effect.map((rows) => !changedNone(rows)));

  /**
   * Refund a payment cire decided it cannot grant, and record what Stripe did.
   * The row already reads `refunding` — the decision is committed before
   * Stripe is asked, so no later delivery can grant it.
   *
   * ONE IDEMPOTENCY KEY PER PURCHASE. A refund that ran at Stripe while this
   * call timed out comes back on the next attempt with its id. Stripe also
   * keeps a refusal under the key for at least a day and answers every repeat
   * with it, so a refused refund's next fresh attempt comes from the daily
   * reconciliation a day or two later — never from a webhook answered 500,
   * which would only replay the refusal and count against the endpoint.
   *
   * Two refusals no retry can change go to a person at once
   * (`refund_failed`): no payment to refund, and a disputed charge, whose money
   * the dispute decides. A call whose answer never arrived — Stripe
   * unreachable, a timeout, a body nobody could read — and one another
   * delivery is still making stay `refunding` (`"refunding"`), since a refund
   * may exist at Stripe; only a refusal Stripe answered counts towards the
   * reconciliation's give-up (`"refund_failed"`).
   */
  const refundPurchase = (
    db: Db,
    purchase: { id: string; label: PaidTier | "unmapped"; paymentIntentId: string | null },
  ): Effect.Effect<SettleOutcome> =>
    Effect.gen(function* () {
      const refused = (
        reason: string,
        fields: { status?: number | undefined; code?: string | undefined },
        final: boolean,
      ) =>
        Effect.gen(function* () {
          metricUpgradePurchaseSettled(purchase.label, "refund_failed");
          const handed = final
            ? yield* leaveRefunding(db, purchase.id, { status: "refund_failed" })
            : false;
          // The code and status only: a Stripe message can quote the request.
          yield* Effect.logError("upgrade refund failed", {
            purchaseId: purchase.id,
            reason,
            ...fields,
            handedToAPerson: handed,
          });
          return "refund_failed" as const;
        });

      /** No answer arrived, so a refund may exist at Stripe: ask again later. */
      const unanswered = (reason: string) =>
        Effect.gen(function* () {
          metricUpgradePurchaseSettled(purchase.label, "refund_failed");
          yield* Effect.logError("upgrade refund failed", {
            purchaseId: purchase.id,
            reason,
            handedToAPerson: false,
          });
          return "refunding" as const;
        });

      if (purchase.paymentIntentId === null) return yield* refused("no payment intent", {}, true);
      const paymentIntentId = purchase.paymentIntentId;

      const attempt = yield* Effect.result(
        deps.stripe.createPlatformRefund({
          paymentIntentId,
          metadata: { purchaseId: purchase.id },
          idempotencyKey: `cire-upgrade-refund-${purchase.id}`,
        }),
      );

      if (attempt._tag === "Success") {
        const moved = yield* leaveRefunding(db, purchase.id, {
          status: "auto_refunded",
          refundId: attempt.success.id,
        });
        // Not moved: another delivery recorded the same refund first.
        metricUpgradePurchaseSettled(purchase.label, moved ? "auto_refunded" : "replayed");
        return moved ? ("auto_refunded" as const) : ("replayed" as const);
      }

      const error = attempt.failure;
      const fields = { status: error.status, code: error.code };
      if (error.code === "charge_already_refunded") {
        // Refunded already: by cire, in a call that ran at Stripe while this
        // side timed out and whose key has since gone, or by a person. Only
        // cire's own refund carries this purchase's id.
        const own = yield* Effect.result(
          deps.stripe.findPlatformRefund(paymentIntentId, purchase.id),
        );
        if (own._tag === "Failure") return yield* unanswered(own.failure.reason);
        const moved =
          own.success !== null
            ? yield* leaveRefunding(db, purchase.id, {
                status: "auto_refunded",
                refundId: own.success.id,
              })
            : yield* leaveRefunding(db, purchase.id, { status: "refunded" });
        // Not moved: another delivery recorded it first.
        const outcome = !moved ? "replayed" : own.success !== null ? "auto_refunded" : "refunded";
        metricUpgradePurchaseSettled(purchase.label, outcome);
        return outcome;
      }
      if (error.status === 409 && error.code?.startsWith("idempotency") === true) {
        // Another delivery's request under the same key is still running at
        // Stripe. Not a refusal: that one will record its answer.
        yield* Effect.logWarning("upgrade refund in progress elsewhere", {
          purchaseId: purchase.id,
        });
        return "refunding" as const;
      }
      if (error.reason !== "rejected" && error.reason !== "unexpected refund payload") {
        return yield* unanswered(error.reason);
      }
      return yield* refused(error.reason, fields, error.code === "charge_disputed");
    }).pipe(Effect.withSpan("cire.upgrade.refund"));

  /**
   * Settle a purchase from what Stripe says a session of its own paid. The
   * ONLY place a tier is granted from a payment, and the only place an upgrade
   * payment is refunded automatically. See `settlePurchase` below.
   */
  const settle = (input: SettleInput, depth = 0): Effect.Effect<SettleOutcome, never, DbService> =>
    Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddingUpgradePurchases.id,
            weddingId: weddingUpgradePurchases.weddingId,
            product: weddingUpgradePurchases.entitlement,
            status: weddingUpgradePurchases.status,
            sessionId: weddingUpgradePurchases.checkoutSessionId,
            paymentIntentId: weddingUpgradePurchases.paymentIntentId,
            fromTier: weddingUpgradePurchases.fromTier,
            // The wedding as it is now, in the same read, for the refund
            // rules below. A LEFT JOIN, so a wedding that is gone reads as
            // not live rather than as no purchase.
            weddingTier: weddings.tier,
            weddingGrantedBy: weddings.tierGrantedBy,
            weddingLive: sql<number>`(${weddings.id} IS NOT NULL AND ${weddings.deletedAt} IS NULL)`,
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
        return "unknown" as const;
      }

      // OURS is the session this row holds. Only `startPurchase` writes it,
      // from Stripe's answer to cire's own create call, and it hands the
      // payment page out only after the write lands. So a session the row
      // does not hold — including any session for a row that holds none — was
      // never given to anyone by cire: it grants nothing and is not refunded.
      if (row.sessionId !== input.checkoutSessionId) {
        yield* Effect.logError("upgrade settle for a session the purchase does not hold", {
          purchaseId: row.id,
          heldSessionId: row.sessionId,
          checkoutSessionId: input.checkoutSessionId,
        });
        return "unknown" as const;
      }

      const tier = tierForProduct(row.product);
      const purchase = {
        id: row.id,
        weddingId: row.weddingId,
        tier,
        label: tier ?? ("unmapped" as const),
        paymentIntentId: input.paymentIntentId ?? row.paymentIntentId,
        fromTier: row.fromTier,
      };

      if (!isOpen(row.status)) return yield* after(db, purchase, row.status, input, depth);

      if (!input.paid) {
        // Card-only sessions cannot complete unpaid, so this should never
        // fire — but granting on an unpaid session is the one mistake that
        // cannot be undone by a retry, so the check stays. No money moved,
        // so there is nothing to refund either.
        metricUpgradePurchaseSettled(purchase.label, "unpaid");
        return "unpaid" as const;
      }

      const reason = refundReason(row, tier);
      if (reason === null && tier !== null) return yield* grant(db, purchase, tier, input, depth);

      yield* Effect.logError("upgrade settle refunding a payment it cannot grant", {
        purchaseId: row.id,
        reason,
      });
      const claimed = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .update(weddingUpgradePurchases)
            .set({ status: "refunding", ...arrived(input), updatedAt: new Date(now()) })
            .where(
              and(
                eq(weddingUpgradePurchases.id, row.id),
                // oxlint-disable-next-line house/no-unbounded-in-array -- OPEN_STATUSES is a four-member constant
                inArray(weddingUpgradePurchases.status, [...OPEN_STATUSES]),
                eq(weddingUpgradePurchases.checkoutSessionId, input.checkoutSessionId),
                // The read's decision, held again here, as the grant's flip
                // holds its own: a restore or a raise landing in between leaves
                // the row open, and a fresh read grants it.
                tier === null ? undefined : not(grantable(purchase, tier)),
              ),
            ),
          statusReadBack(db, row.id),
        ]),
      );
      // Whatever the row reads now decides: `refunding` from this claim or a
      // concurrent one, or a grant that landed first.
      return yield* after(db, purchase, readBack(claimed[1]), input, depth);
    });

  /**
   * One D1 batch: flip the row to `succeeded`, then — each only while the row
   * reads `succeeded` — raise the tier and write the sales row, then read the
   * row back. D1 runs a batch atomically and in statement order. bun:sqlite has
   * no `.batch()`, so the helper chains them in the same order.
   *
   * A row already `succeeded` is a replay: the flip matches nothing and the
   * grant and the sale run again, both idempotent — the grant only ever
   * raises, the sale is keyed on the purchase. NOTHING may short-circuit on
   * "this row already reads succeeded": that is the state a crash between the
   * flip and the grant would leave, and re-running is what repairs it.
   */
  const grant = (
    db: Db,
    purchase: PurchaseRef,
    tier: PaidTier,
    input: SettleInput,
    depth: number,
  ): Effect.Effect<SettleOutcome, never, DbService> =>
    Effect.gen(function* () {
      const currency = input.paidCurrency?.toUpperCase() ?? null;
      const results = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .update(weddingUpgradePurchases)
            .set({ status: "succeeded", ...arrived(input), updatedAt: new Date(now()) })
            .where(
              and(
                eq(weddingUpgradePurchases.id, purchase.id),
                // oxlint-disable-next-line house/no-unbounded-in-array -- OPEN_STATUSES is a four-member constant
                inArray(weddingUpgradePurchases.status, [...OPEN_STATUSES]),
                eq(weddingUpgradePurchases.checkoutSessionId, input.checkoutSessionId),
                // The read's decision, held again here: a delete or a comp
                // landing between that read and this batch leaves the row
                // open, and a fresh read refunds it.
                grantable(purchase, tier),
              ),
            )
            .returning({ id: weddingUpgradePurchases.id }),
          // Only ever raises the tier, so a replay — or a late delivery for a
          // lower tier than the wedding has since reached — changes nothing.
          tierService.tierGrantStatement(
            db,
            purchase.weddingId,
            tier,
            {
              source: "purchase",
              // A webhook has no actor of its own. The purchase names the
              // buyer, so the grant names the purchase.
              grantedBy: `stripe:${purchase.id}`,
            },
            // A purchase priced from a tier raises only a wedding still on
            // it, on a replay too: the difference's price never buys the
            // whole tier.
            and(purchaseReads(purchase.id, "succeeded"), fromTierHeld(purchase.fromTier)),
          ),
          // Keyed on the purchase, so a redelivery writes one row. Every
          // column, in the table's order; NOT NULL ones guarded as before.
          db
            .insert(platformSales)
            .select(
              db
                .select({
                  id: bound(newId("sal"), platformSales.id),
                  purchaseId: weddingUpgradePurchases.id,
                  entitlement: weddingUpgradePurchases.entitlement,
                  amountMinor: bound(input.paidAmountMinor ?? 0, platformSales.amountMinor),
                  currency: bound(currency ?? "", platformSales.currency),
                  settledAt: bound(new Date(now()), platformSales.settledAt),
                })
                .from(weddingUpgradePurchases)
                .where(
                  and(
                    eq(weddingUpgradePurchases.id, purchase.id),
                    eq(weddingUpgradePurchases.status, "succeeded"),
                  ),
                ),
            )
            .onConflictDoNothing(),
          statusReadBack(db, purchase.id),
        ]),
      );
      const status = readBack(results[3]);
      if (status === "succeeded") {
        const outcome = changedNone(results[0]) ? "replayed" : "granted";
        metricUpgradePurchaseSettled(tier, outcome);
        return outcome;
      }
      // A refund claim, or a person, got there between the read and the batch,
      // or the wedding moved so this payment can no longer grant.
      return yield* after(db, purchase, status, input, depth);
    });

  /**
   * What a row that is no longer open settles to. Reached from the first read,
   * and from the read-back after a guarded write that another delivery beat,
   * so it never opens a second write path of its own.
   */
  const after = (
    db: Db,
    purchase: PurchaseRef,
    status: string | undefined,
    input: SettleInput,
    depth: number,
  ): Effect.Effect<SettleOutcome, never, DbService> =>
    Effect.gen(function* () {
      // Still open after a guarded write: the wedding moved between the read
      // and the batch. One fresh read decides again; there is no third.
      if (status !== undefined && isOpen(status)) {
        if (depth === 0) return yield* settle(input, 1);
        yield* Effect.logError("upgrade settle could not decide", {
          purchaseId: purchase.id,
          status,
        });
        return "unknown" as const;
      }
      switch (status) {
        case "succeeded":
          // A replay of a granted purchase stays a grant, whatever has
          // happened to the wedding since: the money bought the tier.
          if (purchase.tier === null) return "replayed" as const;
          return yield* grant(db, purchase, purchase.tier, input, depth);
        case "refunding":
          return yield* refundPurchase(db, purchase);
        case "auto_refunded":
        case "refund_failed":
          metricUpgradePurchaseSettled(purchase.label, "replayed");
          return "replayed" as const;
        case "refunded":
          metricUpgradePurchaseSettled(purchase.label, "refunded");
          yield* Effect.logWarning("upgrade settle for a refunded purchase", {
            purchaseId: purchase.id,
          });
          return "refunded" as const;
        default:
          // The row vanished between the read and the write (the purge), or
          // holds a status this build does not know.
          yield* Effect.logError("upgrade settle lost its purchase", {
            purchaseId: purchase.id,
            status: status ?? null,
          });
          return "unknown" as const;
      }
    });

  /** Close a purchase Stripe says is over. Only ever moves a `pending` row. */
  const failPurchase = (input: {
    purchaseId: string;
    checkoutSessionId: string;
    status: "failed" | "expired";
  }): Effect.Effect<"closed" | "ignored", never, DbService> =>
    Effect.gen(function* () {
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
      if (changedNone(changed)) return "ignored" as const;
      const product = (changed as { product: string }[])[0]?.product;
      if (product !== undefined) {
        metricUpgradePurchaseSettled(
          tierForProduct(product) ?? "unmapped",
          input.status === "failed" ? "failed" : "expired",
        );
      }
      return "closed" as const;
    }).pipe(Effect.withSpan("cire.upgrade.failPurchase"));

  /**
   * One row of the daily reconciliation. `true` once the row has moved on;
   * `false` leaves it for a later run.
   */
  const reconcileOne = (
    db: Db,
    row: {
      id: string;
      product: string;
      status: string;
      sessionId: string | null;
      paymentIntentId: string | null;
      createdAt: Date;
    },
  ): Effect.Effect<boolean, never, DbService> =>
    Effect.gen(function* () {
      if (row.status === "refunding") {
        const outcome = yield* refundPurchase(db, {
          id: row.id,
          label: tierForProduct(row.product) ?? "unmapped",
          paymentIntentId: row.paymentIntentId,
        });
        // In progress elsewhere, or unanswered: a refund may exist at Stripe,
        // and no timer outranks it.
        if (outcome === "refunding") return false;
        if (outcome !== "refund_failed") return true;
        if (now() - row.createdAt.getTime() < REFUND_GIVE_UP_MS) return false;
        // Asked long enough. A person returns the money before the purge may
        // take the deleted wedding this row belongs to.
        const handed = yield* leaveRefunding(db, row.id, { status: "refund_failed" });
        if (handed) {
          yield* Effect.logError("upgrade refund given up; a person must return the money", {
            purchaseId: row.id,
          });
        }
        return true;
      }
      if (row.sessionId === null) return false;
      const sessionId = row.sessionId;
      const probe = yield* probeSession(row.id, sessionId);
      if (probe.status === "expired") {
        // Only Stripe's own `expired` closes the row: the probe answers
        // `expired` for a session it cannot read plainly, too.
        if (probe.stripeStatus !== "expired") return false;
        yield* failPurchase({
          purchaseId: row.id,
          checkoutSessionId: sessionId,
          status: "expired",
        });
        return true;
      }
      if (probe.status !== "complete" || probe.payment === undefined) return false;
      const payment = probe.payment;
      if (payment.paid && payment.refunded) {
        // A person refunded it while its webhook kept failing. Record the
        // refund; never grant a tier for money already given back.
        yield* dbQuery(() =>
          db
            .update(weddingUpgradePurchases)
            .set({
              status: "refunded",
              paymentIntentId: paymentIntentOr(payment.paymentIntentId),
              updatedAt: new Date(now()),
            })
            .where(
              and(
                eq(weddingUpgradePurchases.id, row.id),
                eq(weddingUpgradePurchases.status, "pending"),
                eq(weddingUpgradePurchases.checkoutSessionId, sessionId),
              ),
            )
            .run(),
        );
        return true;
      }
      const outcome = yield* settle({
        purchaseId: row.id,
        checkoutSessionId: sessionId,
        paid: payment.paid,
        paidAmountMinor: payment.amountMinor,
        paidCurrency: payment.currency,
        paymentIntentId: payment.paymentIntentId,
      });
      return outcome !== "unpaid" && outcome !== "unknown";
    });

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
        //    or not closable, means wait. Removed by englishstreetventures/osn#1315.
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
     * Settle a purchase from a verified webhook delivery, or from the daily
     * reconciliation's read of the session. The ONLY place a tier is granted
     * from a payment.
     *
     * OURS, AND WHAT IT BOUGHT. The purchase id comes from
     * `client_reference_id`, which any payment on this Stripe account can
     * carry, so it proves nothing. The session the row holds does: only this
     * platform's own create call wrote it, and that session sold exactly the
     * Price the row recorded, for the row's tier. A payment for any other
     * session grants nothing and is not refunded — it is not cire's to keep or
     * to give back.
     *
     * A PAID CHECKOUT OF OURS UPGRADES THE WEDDING OR IS REFUNDED, whatever
     * amount Checkout charged. When it cannot grant — the product names no
     * tier, the wedding is deleted, a purchase priced from a tier finds the
     * wedding lowered below it, or the wedding already holds the tier some
     * other way — the
     * row moves to `refunding` FIRST and the payment is refunded through
     * Stripe, so no later delivery can grant it. A refund Stripe refuses is
     * logged and counted (`refund_failed`), the row stays `refunding`, and the
     * daily reconciliation asks again.
     *
     * Whichever of a grant and a refund claim lands first decides: each is a
     * write guarded on the row still being open, and the loser follows what
     * the row reads back.
     */
    settlePurchase(input: SettleInput): Effect.Effect<SettleOutcome, never, DbService> {
      return settle(input).pipe(Effect.withSpan("cire.upgrade.settlePurchase"));
    },

    failPurchase,

    /**
     * Stripe says a refund cire made failed after it accepted it — the bank
     * returned it. The money is back in cire's balance, so a person has to
     * return it another way: the row says so, and the failure is logged and
     * counted. Only the refund the row recorded moves it, so a refund that is
     * not cire's changes nothing.
     */
    refundFailed(input: {
      purchaseId: string;
      refundId: string;
    }): Effect.Effect<"recorded" | "ignored", never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const changed = yield* dbQuery(() =>
          db
            .update(weddingUpgradePurchases)
            .set({ status: "refund_failed", refundId: input.refundId, updatedAt: new Date(now()) })
            .where(
              and(
                eq(weddingUpgradePurchases.id, input.purchaseId),
                or(
                  and(
                    eq(weddingUpgradePurchases.status, "auto_refunded"),
                    eq(weddingUpgradePurchases.refundId, input.refundId),
                  ),
                  // A refund Stripe accepted while cire's call timed out, so
                  // its id was never recorded. Only cire's own create call
                  // names a purchase in a refund's metadata, and the row's
                  // `refunding` guard then keeps the late success off it.
                  and(
                    eq(weddingUpgradePurchases.status, "refunding"),
                    isNull(weddingUpgradePurchases.refundId),
                  ),
                ),
              ),
            )
            .returning({ product: weddingUpgradePurchases.entitlement })
            .all(),
        );
        const product = (changed as { product: string }[])[0]?.product;
        if (product === undefined) {
          // Our refund, but no purchase this build still holds in
          // `auto_refunded` with it: the purge took a deleted wedding's row,
          // or the row moved since. The money is still owed, so a person
          // must see it — unless this is a redelivery of one already recorded.
          const rows = yield* dbQuery(() =>
            db
              .select({ status: weddingUpgradePurchases.status })
              .from(weddingUpgradePurchases)
              .where(
                and(
                  eq(weddingUpgradePurchases.id, input.purchaseId),
                  eq(weddingUpgradePurchases.refundId, input.refundId),
                ),
              )
              .all(),
          );
          if (rows[0]?.status !== "refund_failed") {
            metricUpgradePurchaseSettled("unmapped", "refund_failed");
            yield* Effect.logError("upgrade refund failed at the bank", {
              purchaseId: input.purchaseId,
              refundId: input.refundId,
              purchaseFound: false,
            });
          }
          return "ignored" as const;
        }
        metricUpgradePurchaseSettled(tierForProduct(product) ?? "unmapped", "refund_failed");
        yield* Effect.logError("upgrade refund failed at the bank", {
          purchaseId: input.purchaseId,
          refundId: input.refundId,
        });
        return "recorded" as const;
      }).pipe(Effect.withSpan("cire.upgrade.refundFailed"));
    },

    /**
     * The daily pass that finishes what a webhook could not. It reads at most
     * {@link RECONCILE_PER_RUN} rows, least recently moved first: a purchase
     * cire decided to refund (`refunding`), whose refund it tries again, and a
     * `pending` purchase whose session has outlived its payable day, whose
     * session it asks Stripe about — settling a paid one exactly as the
     * webhook would (grant, or refund when it cannot) and closing an expired
     * one. A row whose step fails is moved to the back, so one that keeps
     * failing does not hold every run's places.
     */
    reconcile(): Effect.Effect<{ read: number; failed: number }, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              id: weddingUpgradePurchases.id,
              product: weddingUpgradePurchases.entitlement,
              status: weddingUpgradePurchases.status,
              sessionId: weddingUpgradePurchases.checkoutSessionId,
              paymentIntentId: weddingUpgradePurchases.paymentIntentId,
              createdAt: weddingUpgradePurchases.createdAt,
            })
            .from(weddingUpgradePurchases)
            .where(
              or(
                eq(weddingUpgradePurchases.status, "refunding"),
                and(
                  eq(weddingUpgradePurchases.status, "pending"),
                  isNotNull(weddingUpgradePurchases.checkoutSessionId),
                  lte(
                    weddingUpgradePurchases.createdAt,
                    new Date(now() - CHECKOUT_SESSION_LIFETIME_MS),
                  ),
                ),
              ),
            )
            .orderBy(asc(weddingUpgradePurchases.updatedAt), asc(weddingUpgradePurchases.id))
            .limit(RECONCILE_PER_RUN)
            .all(),
        );

        let failed = 0;
        for (const row of rows) {
          const done = yield* reconcileOne(db, row).pipe(
            Effect.catchDefect((cause) =>
              Effect.logError("upgrade reconcile step failed", {
                purchaseId: row.id,
                cause: String(cause),
              }).pipe(Effect.as(false)),
            ),
          );
          if (!done) failed += 1;
          // To the back of the queue, whatever happened: a row that is still
          // where it was must not hold the run's few places for good. Guarded
          // on the status it was read in, so a row that moved on is untouched.
          yield* dbQuery(() =>
            db
              .update(weddingUpgradePurchases)
              .set({ updatedAt: new Date(now()) })
              .where(
                and(
                  eq(weddingUpgradePurchases.id, row.id),
                  eq(weddingUpgradePurchases.status, row.status),
                ),
              )
              .run(),
          );
        }
        // Every day a refund waits for a person, say so: the hand-over's own
        // log line is one line, and the purge keeps the wedding until then.
        const waiting = yield* dbQuery(() =>
          db
            .select({ n: count() })
            .from(weddingUpgradePurchases)
            .where(eq(weddingUpgradePurchases.status, "refund_failed"))
            .all(),
        );
        const owed = waiting[0]?.n ?? 0;
        if (owed > 0) {
          yield* Effect.logError("upgrade refunds waiting for a person", { count: owed });
        }
        return { read: rows.length, failed };
      }).pipe(Effect.withSpan("cire.upgrade.reconcile"));
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
