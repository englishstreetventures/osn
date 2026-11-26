/**
 * Small scheduled sweeps for tables whose rows expire but nothing deleted
 * (data-layer review 2026-07-30). Both run from the Worker's daily cron
 * alongside the session + retention sweeps, each in its own `waitUntil`.
 *
 *  - `vendor_claims`: claim tokens carry `expires_at` (7-day TTL) and
 *    `consumed_at`, but no code path ever deleted them — expired and consumed
 *    tokens accumulated forever. Rows are deleted once PAST EXPIRY (consumed
 *    rows keep their audit value until then; they expire like any other).
 *    Token hashes are not sensitive at rest (SHA-256 of 256-bit random), so
 *    this is hygiene, not a security fix.
 *
 *  - `imports` rows stuck in `status='preview'`: an organiser who uploads a
 *    sheet and abandons the preview leaves the row + BOTH uploaded CSVs
 *    (guest PII, in `cire-sheets`) alive until the wedding ages out of the
 *    1-year retention sweep. Previews older than the staleness window are
 *    deleted and their sheet objects reaped — collect-keys-then-delete-then-
 *    reap, the retention sweep's ordering. Applied/reverted rows are never
 *    touched (they are the change history + revert source).
 *
 *  - Soft-deleted weddings past their restore window, or with no owner left to
 *    restore them: hard-deleted, with every child row by FK cascade and every
 *    R2 object their rows name. See `purgeDeletedWeddings`.
 *
 *  - Retired Standard Stripe accounts past their 120 days: handed back to
 *    their holders, on a cron trigger of their own. See
 *    `handBackRetiredAccounts`.
 */

import {
  events,
  imports,
  registryContributions,
  registryItems,
  registryRetiredAccounts,
  registrySettings,
  vendorClaims,
  weddingHosts,
  weddingInviteCustomisations,
  weddings,
  weddingUpgradePurchases,
} from "@cire/db";
import { jsonEachIn, rowsChanged } from "@shared/db-utils";
import { and, asc, count, eq, isNotNull, isNull, lt, lte, min, not, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Cause, Clock, Data, Effect } from "effect";

import { commitBatchResults, DbService, outerColumn } from "../db";
import { epochSeconds, RESTORE_WINDOW_S } from "../db/live-wedding";
import {
  metricRegistryStripeHandBack,
  metricStalePreviewsSwept,
  metricVendorClaimsSwept,
  metricWeddingPurgeBacklog,
  metricWeddingPurged,
} from "../metrics";
import { INVITE_IMAGE_SLOTS } from "../schemas/invite";
import { SLOT_COLUMNS } from "./invite";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";
import { registryService } from "./registry";
import type { StripeError } from "./stripe";
import { changeClaimLive } from "./wedding-lifecycle";

class MaintenanceSweepError extends Data.TaggedError("MaintenanceSweepError")<{
  op: "vendor_claims" | "stale_previews" | "purge_deleted_weddings" | "hand_back_retired_accounts";
  reason: string;
}> {}

/**
 * Deleted weddings one daily run hard-deletes, oldest first. A bounded
 * estimate, not a measurement: every cron job shares one invocation's D1
 * query ceiling, and a purge's cascade is the largest single write any job
 * makes. A run that leaves more due than this logs it and records the backlog.
 */
export const MAX_PURGES_PER_RUN = 3;

/**
 * Standard accounts one purge hands back: the wedding's own and the ones it
 * retired, oldest retire first. Each is a Stripe call in the invocation the
 * whole daily cron shares, so a run makes at most `MAX_PURGES_PER_RUN` times
 * this.
 */
export const PURGE_HAND_BACKS = 2;

/**
 * The `weddings` row the statement is about has no owner seat left. Only an
 * owner can restore a deleted wedding, so one with none has nothing to wait
 * for: the erasure of its only owner's account leaves it this way
 * (`account-erasure.ts`).
 */
export const noOwnerLeft = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${outerColumn(weddings.id)} AND ${weddingHosts.role} = 'owner')`;

/**
 * A soft-deleted wedding the purge may take: past its restore window, or with
 * no owner seat left ({@link noOwnerLeft}). `cutoffS` is SECONDS. Reads the
 * `weddings` row the statement is about.
 */
const pastRestoreWindow = (cutoffS: number): SQL =>
  sql`(${weddings.deletedAt} IS NOT NULL AND (${weddings.deletedAt} <= ${cutoffS} OR ${noOwnerLeft()}))`;

/**
 * How long a pending upgrade purchase or gift holds a past-window wedding back
 * from the purge, from its `created_at` (SECONDS). No new pending row can be
 * started on a deleted wedding later than one request that passed its gate
 * just before the delete, and Stripe closes that request's session within a
 * day, so this always ends.
 */
export const PURGE_PENDING_HOLD_S = 14 * 24 * 60 * 60;

/**
 * Why a past-window wedding is not purged yet: money that can still move, or a
 * change still writing. `wedding` is a bound id or the outer row's id
 * (`outerColumn`); `nowS` is SECONDS, `nowMs` MILLISECONDS. The statement must
 * read `weddings` as its own table, for the change-claim half.
 *
 * A `disputed` gift holds however old it is: a dispute reaches the platform's
 * balance, and its close must find the row. An upgrade refund cire still owes
 * does not hold: its record (`platform_refunds`) is outside the cascade, and
 * the daily reconciliation completes it from there.
 *
 * The one definition of a hold: an account's erasure reads it too, to report
 * the deleted weddings it leaves held (`account-erasure.ts`).
 */
export const purgeHeld = (wedding: SQL | string, nowS: number, nowMs: number): SQL =>
  sql`(EXISTS (SELECT 1 FROM ${weddingUpgradePurchases} WHERE ${weddingUpgradePurchases.weddingId} = ${wedding} AND ${weddingUpgradePurchases.status} = 'pending' AND ${weddingUpgradePurchases.createdAt} > ${nowS - PURGE_PENDING_HOLD_S}) OR EXISTS (SELECT 1 FROM ${registryContributions} WHERE ${registryContributions.weddingId} = ${wedding} AND (${registryContributions.status} = 'disputed' OR (${registryContributions.status} = 'pending' AND ${registryContributions.createdAt} > ${nowS - PURGE_PENDING_HOLD_S}))) OR ${changeClaimLive(nowMs)})`;

interface PurgeRunResult {
  purged: number;
  held: number;
  errors: number;
  /** Due, unheld weddings this run's cap left for a later one. */
  backlog: number;
}

type KeyRow = Record<string, string | null>;

/** Every non-empty key in the rows, in column order. */
const keysOf = (rows: readonly KeyRow[]): string[] =>
  rows.flatMap((row) => Object.values(row).filter((k): k is string => !!k));

/**
 * Each invite image slot's key column, by slot, taken from `SLOT_COLUMNS` for
 * every slot, so a slot added to `INVITE_IMAGE_SLOTS` is reaped with no edit
 * here. Only key columns, so `keysOf` may take every value.
 */
const slotKeyFields = Object.fromEntries(
  INVITE_IMAGE_SLOTS.map((slot) => [slot, weddingInviteCustomisations[SLOT_COLUMNS[slot].key]]),
);

/**
 * A preview never applied within this window is abandoned: the organiser's
 * portal flow previews and applies in one sitting, so 7 days is generous while
 * still bounding how long an orphaned sheet upload (guest PII) can linger.
 */
export const PREVIEW_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Purge one past-window wedding: see `purgeDeletedWeddings`. `"held"` when
 * the guarded delete matched nothing — restored, or a hold appeared, after the
 * candidate read.
 */
function purgeOne(
  candidate: { id: string; deletedBy: string | null },
  nowS: number,
  nowMs: number,
  cutoffS: number,
  reapTo: { sheets?: DeletableBucket; assets?: DeletableBucket },
  stripe: PurgeStripe,
): Effect.Effect<"ok" | "held", MaintenanceSweepError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const weddingId = candidate.id;
    // Four single-table reads, each with its key columns side by side and
    // unpivoted below. NOT one compound SELECT with a term per column: D1
    // allows at most 5 terms in a `UNION`/`UNION ALL` (bun:sqlite allows
    // 500), so a term per key column fails every purge on D1 while every
    // local test passes.
    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .select({
              events: imports.eventsR2Key,
              guests: imports.guestsR2Key,
              beforeEvents: imports.beforeEventsR2Key,
              beforeGuests: imports.beforeGuestsR2Key,
            })
            .from(imports)
            .where(eq(imports.weddingId, weddingId)),
          db
            .select(slotKeyFields)
            .from(weddingInviteCustomisations)
            .where(eq(weddingInviteCustomisations.weddingId, weddingId)),
          db
            .select({ key: events.eventImageKey })
            .from(events)
            .where(and(eq(events.weddingId, weddingId), isNotNull(events.eventImageKey))),
          db
            .select({ key: registryItems.imageKey })
            .from(registryItems)
            .where(and(eq(registryItems.weddingId, weddingId), isNotNull(registryItems.imageKey))),
          db
            .select({
              stripeAccountId: registrySettings.stripeAccountId,
              stripeAccountType: registrySettings.stripeAccountType,
            })
            .from(registrySettings)
            .where(eq(registrySettings.weddingId, weddingId)),
          // The Standard accounts the wedding retired that cire still holds,
          // read before the delete cascades them away: each is handed back
          // below once nothing else holds it, or named in a log line. Every
          // one, with no cap: a row exists only where an owner signed in at
          // Stripe to connect that account and then retired it, and an id
          // left unread here would leave cire holding the account with no
          // record of it.
          db
            .select({ stripeAccountId: registryRetiredAccounts.stripeAccountId })
            .from(registryRetiredAccounts)
            .where(
              and(
                eq(registryRetiredAccounts.weddingId, weddingId),
                eq(registryRetiredAccounts.stripeAccountType, "standard"),
                isNull(registryRetiredAccounts.releasedAt),
              ),
            )
            .groupBy(registryRetiredAccounts.stripeAccountId)
            .orderBy(
              min(registryRetiredAccounts.retiredAt),
              registryRetiredAccounts.stripeAccountId,
            ),
          db
            .delete(weddings)
            .where(
              and(
                eq(weddings.id, weddingId),
                pastRestoreWindow(cutoffS),
                not(purgeHeld(weddingId, nowS, nowMs)),
              ),
            )
            .returning({ id: weddings.id }),
        ]),
      catch: (e) => new MaintenanceSweepError({ op: "purge_deleted_weddings", reason: String(e) }),
    });

    const [deleted] = results[6] as readonly { id: string }[];
    // Restored, or a hold appeared, between the candidate read and here.
    if (!deleted) return "held" as const;

    const sheetKeys = keysOf(results[0] as readonly KeyRow[]);
    const assetKeys = [
      ...keysOf(results[1] as readonly KeyRow[]),
      ...keysOf(results[2] as readonly KeyRow[]),
      ...keysOf(results[3] as readonly KeyRow[]),
    ];
    yield* reapR2Objects(reapTo.sheets, "sheets", sheetKeys);
    yield* reapR2Objects(reapTo.assets, "assets", assetKeys);
    const [settings] = results[4] as readonly {
      stripeAccountId: string | null;
      stripeAccountType: "express" | "standard" | null;
    }[];
    const retired = (results[5] as readonly { stripeAccountId: string }[]).map(
      (row) => row.stripeAccountId,
    );
    const current =
      settings?.stripeAccountId && settings.stripeAccountType === "standard"
        ? [settings.stripeAccountId]
        : [];
    yield* handBackStandardAccounts(weddingId, [...new Set([...current, ...retired])], stripe);
    // The only record left once the rows are gone: ids and counts, no names.
    yield* Effect.logInfo("wedding purged", {
      weddingId,
      deletedByProfileId: candidate.deletedBy,
      sheetKeys: sheetKeys.length,
      assetKeys: assetKeys.length,
    });
    return "ok" as const;
  }).pipe(Effect.withSpan("cire.wedding.purge"));
}

/** How the purge hands a Standard account back; absent where OAuth is not configured. */
export interface PurgeStripe {
  readonly deauthorize?: (accountId: string) => Effect.Effect<void, StripeError>;
}

/**
 * A purged wedding's Standard accounts — the couple's own, connected through
 * OAuth: the one it named and the ones it retired — are handed back when
 * nothing else holds them (no settings row names one, and no wedding retired
 * one cire has not let go), so cire keeps no access to an account it no longer
 * uses and stops hearing its events. An Express account cire created stays at
 * Stripe, as it always has. At most {@link PURGE_HAND_BACKS} a purge, in the
 * order given; each further one nothing else holds is logged with its id for a
 * hand fix, as is a refused call, and as is every candidate when the read that
 * would say what else holds them fails. Best-effort: the rows are already
 * gone, and the purge still counts.
 */
function handBackStandardAccounts(
  weddingId: string,
  candidates: readonly string[],
  stripe: PurgeStripe,
): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const deauthorize = stripe.deauthorize;
    if (candidates.length === 0 || !deauthorize) return;
    const db = yield* DbService;
    // One read for every candidate: the ones something else still holds.
    const held = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          db.all<{ id: string }>(
            sql`SELECT ${registrySettings.stripeAccountId} AS id FROM ${registrySettings}
                WHERE ${registrySettings.stripeAccountId} IN ${jsonEachIn(candidates)}
                UNION
                SELECT ${registryRetiredAccounts.stripeAccountId} AS id FROM ${registryRetiredAccounts}
                WHERE ${registryRetiredAccounts.releasedAt} IS NULL
                  AND ${registryRetiredAccounts.stripeAccountId} IN ${jsonEachIn(candidates)}`,
          ),
        ),
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    const notHandedBack = (accountId: string) =>
      Effect.logError("stripe account not handed back after purge").pipe(
        Effect.annotateLogs({ weddingId, stripeAccountId: accountId }),
      );
    // Unknown is not "nobody": handing back an account another wedding uses
    // would end that wedding's gifts. Each is named for a hand fix instead.
    if (held === null) {
      yield* Effect.forEach(candidates, notHandedBack, { discard: true });
      return;
    }
    const heldIds = new Set(held.map((row) => row.id));
    const free = candidates.filter((id) => !heldIds.has(id));
    yield* Effect.forEach(
      free,
      (accountId, i) =>
        i < PURGE_HAND_BACKS
          ? deauthorize(accountId).pipe(
              Effect.catchTag("StripeError", () => notHandedBack(accountId)),
            )
          : notHandedBack(accountId),
      { discard: true },
    );
  });
}

/**
 * How long a retired Standard account stays connected after its last retire
 * before cire hands it back (the owner's decision), in SECONDS: late refunds
 * and most disputes on its gifts still reach the gift log meanwhile.
 */
export const RETIRED_HAND_BACK_AFTER_S = 120 * 24 * 60 * 60;

/**
 * Retired Standard accounts one run of the hand-back sweep reaches. Each costs
 * at most two Stripe calls and two D1 statements, and the run one read more,
 * and one control read and call once a run: 8 queries and 7 calls at the cap,
 * alone on the sweep's own cron trigger.
 */
export const HAND_BACKS_PER_RUN = 3;

/** What the hand-back sweep needs of Stripe. */
export interface HandBackStripe {
  /** `POST /oauth/deauthorize`: give the account back to its holder. */
  readonly deauthorize: (accountId: string) => Effect.Effect<void, StripeError>;
  /** `GET /v1/accounts/:id`: whether cire still reaches the account. */
  readonly retrieveAccount: (accountId: string) => Effect.Effect<unknown, StripeError>;
}

interface HandBackRunResult {
  handedBack: number;
  /** Accounts Stripe no longer let cire reach: released without a call. */
  released: number;
  failed: number;
  /** More accounts were due than the run's cap. */
  more: boolean;
}

/**
 * Stripe's answer to a read of an account the key cannot reach: one that does
 * not exist, is not connected to the platform, or no longer grants it access
 * (docs.stripe.com/error-codes, `account_invalid`). Another platform's key, or
 * the wrong mode, answers the same, so it counts only beside a control read.
 */
const unreachable = (error: StripeError): boolean =>
  error.status === 403 && error.code === "account_invalid";

export const maintenanceSweeps = {
  /** Delete every vendor-claim token past its expiry. Returns rows deleted. */
  sweepExpiredVendorClaims(
    now: Date = new Date(),
  ): Effect.Effect<number, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(db.delete(vendorClaims).where(lte(vendorClaims.expiresAt, now)).run()),
        catch: (e) => new MaintenanceSweepError({ op: "vendor_claims", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("vendor-claim sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricVendorClaimsSwept("ok", deleted));
      yield* Effect.logInfo("vendor-claim sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricVendorClaimsSwept("error"))),
      Effect.withSpan("cire.maintenance.sweepExpiredVendorClaims"),
    );
  },

  /**
   * Delete `preview` change rows older than the staleness window and reap the
   * uploaded-sheet R2 objects they reference. Returns rows deleted.
   */
  sweepStalePreviews(
    now: Date = new Date(),
    buckets: { sheets?: DeletableBucket } = {},
  ): Effect.Effect<number, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cutoff = now.getTime() - PREVIEW_STALE_AFTER_MS;

      // Collect the sheet keys BEFORE deleting — once the rows are gone the
      // keys are unrecoverable (D1 never reaches into R2).
      const stale = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .select({
                id: imports.id,
                eventsKey: imports.eventsR2Key,
                guestsKey: imports.guestsR2Key,
              })
              .from(imports)
              .where(and(eq(imports.status, "preview"), lt(imports.uploadedAt, cutoff)))
              .all(),
          ),
        catch: (e) => new MaintenanceSweepError({ op: "stale_previews", reason: String(e) }),
      });
      if (stale.length === 0) {
        yield* Effect.sync(() => metricStalePreviewsSwept("ok", 0));
        return 0;
      }
      const sheetKeys = stale.flatMap((r) => [r.eventsKey, r.guestsKey]);

      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(imports)
              .where(and(eq(imports.status, "preview"), lt(imports.uploadedAt, cutoff)))
              .run(),
          ),
        catch: (e) => new MaintenanceSweepError({ op: "stale_previews", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("stale-preview sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricStalePreviewsSwept("ok", deleted));
      yield* Effect.logInfo("stale-preview sweep complete", { deleted });

      // Best-effort, post-delete (same ordering as the retention sweep): a
      // reap failure can't leave a live row pointing at a deleted object.
      yield* reapR2Objects(buckets.sheets, "sheets", sheetKeys);

      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricStalePreviewsSwept("error"))),
      Effect.withSpan("cire.maintenance.sweepStalePreviews"),
    );
  },

  /**
   * Hard-delete soft-deleted weddings whose restore window has passed, or that
   * no owner is left to restore ({@link pastRestoreWindow}), at most
   * {@link MAX_PURGES_PER_RUN} a run, oldest first, skipping any {@link purgeHeld}
   * holds so a held wedding never blocks the rest of the queue.
   *
   * Per wedding, ONE batch: the R2 keys its rows name, then the guarded
   * delete. A D1 batch is one transaction, so the keys read are exactly the
   * rows deleted, and the delete re-checks the window (a restore that landed
   * after the candidate read wins) and the holds (a webhook that landed after
   * it wins). FK cascades take every child row; `platform_sales` has no FK and
   * survives. The R2 reap runs only after the delete returned its row, and is
   * best-effort: a failure is logged and counted, never a reason to fail the
   * sweep — the rows are already gone.
   *
   * A failure on one wedding is logged and counted, and the run goes on.
   */
  purgeDeletedWeddings(
    now: Date = new Date(),
    buckets: { sheets?: DeletableBucket; assets?: DeletableBucket } = {},
    stripe: PurgeStripe = {},
  ): Effect.Effect<PurgeRunResult, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const nowS = epochSeconds(now);
      const nowMs = now.getTime();
      const cutoffS = nowS - RESTORE_WINDOW_S;
      const pastWindow = pastRestoreWindow(cutoffS);
      const heldHere = purgeHeld(outerColumn(weddings.id), nowS, nowMs);
      const failRead = (e: unknown) =>
        new MaintenanceSweepError({ op: "purge_deleted_weddings", reason: String(e) });

      // Two reads, both on the partial index: how many are due and held, and
      // the first few that are not held. Neither needs the other's answer, so
      // they go in one batch: one round trip, the run with nothing due included.
      const [totalRows, candidates] = yield* Effect.tryPromise({
        try: async () => {
          const [totalsRead, candidatesRead] = await commitBatchResults(db, [
            db
              .select({
                due: count(),
                held: sql<number>`coalesce(sum(CASE WHEN ${heldHere} THEN 1 ELSE 0 END), 0)`,
              })
              .from(weddings)
              .where(pastWindow),
            db
              .select({
                id: weddings.id,
                // The deleter only while they still hold a seat on it. No
                // route changes the seats of a deleted wedding, so a deleter
                // with none is a person whose account erasure took it, and
                // whose profile the erasure's last call has yet to clear: no
                // log names them.
                deletedBy: sql<
                  string | null
                >`CASE WHEN EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${outerColumn(weddings.id)} AND ${weddingHosts.osnProfileId} = ${outerColumn(weddings.deletedByOsnProfileId)}) THEN ${outerColumn(weddings.deletedByOsnProfileId)} END`,
              })
              .from(weddings)
              .where(and(pastWindow, not(heldHere)))
              .orderBy(asc(weddings.deletedAt))
              .limit(MAX_PURGES_PER_RUN),
          ]);
          return [
            totalsRead as readonly { due: number; held: number }[],
            candidatesRead as readonly { id: string; deletedBy: string | null }[],
          ] as const;
        },
        catch: failRead,
      });
      const [totals] = totalRows;
      const due = Number(totals?.due ?? 0);
      let held = Number(totals?.held ?? 0);
      const unheld = due - held;
      if (unheld > MAX_PURGES_PER_RUN) {
        // Not an error: the next run takes the remainder. Logged so a backlog
        // that never drains is visible rather than silent.
        yield* Effect.logInfo("wedding purge hit its per-run cap", {
          cap: MAX_PURGES_PER_RUN,
          due: unheld,
        });
      }

      let purged = 0;
      let errors = 0;
      for (const candidate of candidates) {
        const outcome = yield* purgeOne(candidate, nowS, nowMs, cutoffS, buckets, stripe).pipe(
          Effect.catch((err) =>
            Effect.logError("wedding purge failed", {
              weddingId: candidate.id,
              reason: err.reason,
            }).pipe(Effect.as("error" as const)),
          ),
        );
        if (outcome === "ok") purged += 1;
        else if (outcome === "held") held += 1;
        else errors += 1;
      }

      const backlog = Math.max(0, unheld - candidates.length);
      yield* Effect.sync(() => {
        metricWeddingPurged("ok", purged);
        metricWeddingPurged("held", held);
        metricWeddingPurged("error", errors);
        metricWeddingPurgeBacklog(backlog);
      });
      yield* Effect.logInfo("wedding purge sweep complete", { purged, held, errors, backlog });
      return { purged, held, errors, backlog };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricWeddingPurged("error", 1))),
      Effect.withSpan("cire.maintenance.purgeDeletedWeddings"),
    );
  },

  /**
   * Hand back retired Standard accounts cire no longer needs: at most
   * {@link HAND_BACKS_PER_RUN} a run, never tried first, then the oldest
   * attempt, so a few failing accounts never hold the others back.
   *
   * An account is due when every unreleased retired row naming it, whatever its
   * type, is more than {@link RETIRED_HAND_BACK_AFTER_S} old and one is
   * Standard; no settings row names it; no gift on it is `disputed`, however
   * old, since once it is handed back Stripe stops sending the dispute's close;
   * and none is `pending` with a session and younger than
   * {@link PURGE_PENDING_HOLD_S}, the purge's bound on the same question.
   *
   * A success releases every row naming the account and clears any settings
   * row that took it before Stripe answered (`detachStripeAccount`, with that
   * moment as its time, so a connect after it survives). A refused
   * `deauthorize` proves nothing, since a bad client id is refused the same
   * way: the account is read, and released only when Stripe answers 403
   * `account_invalid` and a control read of an account a settings row still
   * names succeeds, once a run, proving the key reaches this platform. Any
   * other answer sets `last_hand_back_at`, logs the id for a hand fix and goes
   * on. A failure of the run's own writes is logged with the id and the run
   * goes on, with no mark, since the write that would make it may be what
   * failed; a deauthorize that succeeded and whose release failed is released
   * on the next run, by the refusal path.
   */
  handBackRetiredAccounts(
    now: Date,
    stripe: HandBackStripe,
  ): Effect.Effect<HandBackRunResult, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const nowS = epochSeconds(now);
      const failRead = (e: unknown) =>
        new MaintenanceSweepError({ op: "hand_back_retired_accounts", reason: String(e) });
      const due = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .select({ accountId: registryRetiredAccounts.stripeAccountId })
              .from(registryRetiredAccounts)
              .where(
                and(
                  isNull(registryRetiredAccounts.releasedAt),
                  sql`NOT EXISTS (SELECT 1 FROM ${registrySettings} WHERE ${registrySettings.stripeAccountId} = ${outerColumn(registryRetiredAccounts.stripeAccountId)})`,
                  sql`NOT EXISTS (SELECT 1 FROM ${registryContributions} WHERE ${registryContributions.stripeAccountId} = ${outerColumn(registryRetiredAccounts.stripeAccountId)} AND (${registryContributions.status} = 'disputed' OR (${registryContributions.status} = 'pending' AND ${registryContributions.stripeCheckoutSessionId} IS NOT NULL AND ${registryContributions.createdAt} > ${nowS - PURGE_PENDING_HOLD_S})))`,
                ),
              )
              .groupBy(registryRetiredAccounts.stripeAccountId)
              .having(
                sql`max(${registryRetiredAccounts.stripeAccountType} = 'standard') = 1 AND max(${registryRetiredAccounts.retiredAt}) <= ${nowS - RETIRED_HAND_BACK_AFTER_S}`,
              )
              .orderBy(
                sql`max(${registryRetiredAccounts.lastHandBackAt}) IS NOT NULL`,
                sql`max(${registryRetiredAccounts.lastHandBackAt})`,
                min(registryRetiredAccounts.retiredAt),
                registryRetiredAccounts.stripeAccountId,
              )
              .limit(HAND_BACKS_PER_RUN + 1)
              .all(),
          ),
        catch: failRead,
      });
      const more = due.length > HAND_BACKS_PER_RUN;
      if (more) {
        yield* Effect.logInfo("retired stripe account hand-back hit its per-run cap", {
          cap: HAND_BACKS_PER_RUN,
        });
      }

      // Whether the key reaches this platform's accounts, read at most once.
      let control: boolean | undefined;
      const keyReachesPlatform = Effect.gen(function* () {
        if (control !== undefined) return control;
        const [named] = yield* Effect.tryPromise(() =>
          Promise.resolve(
            db
              .select({ accountId: registrySettings.stripeAccountId })
              .from(registrySettings)
              .where(isNotNull(registrySettings.stripeAccountId))
              .orderBy(sql`${registrySettings.stripeAccountUpdatedAt} DESC`)
              .limit(1)
              .all(),
          ),
        );
        control = named?.accountId
          ? yield* stripe.retrieveAccount(named.accountId).pipe(
              Effect.as(true),
              Effect.catchTag("StripeError", () => Effect.succeed(false)),
            )
          : false;
        return control;
      });

      const answeredAt = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
      const release = (accountId: string) =>
        Effect.gen(function* () {
          const observedAt = yield* answeredAt;
          if (yield* registryService.detachStripeAccount({ accountId, observedAt })) {
            yield* Effect.logError("stripe account handed back while a wedding connected it").pipe(
              Effect.annotateLogs({ stripeAccountId: accountId }),
            );
          }
        });
      const notHandedBack = (accountId: string, why: string) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            Promise.resolve(
              db
                .update(registryRetiredAccounts)
                .set({ lastHandBackAt: now })
                .where(
                  and(
                    eq(registryRetiredAccounts.stripeAccountId, accountId),
                    isNull(registryRetiredAccounts.releasedAt),
                  ),
                )
                .run(),
            ),
          );
          yield* Effect.logError("stripe account not handed back").pipe(
            Effect.annotateLogs({ stripeAccountId: accountId, why }),
          );
          return "failed" as const;
        });

      const handBack = (accountId: string) =>
        stripe.deauthorize(accountId).pipe(
          Effect.andThen(release(accountId).pipe(Effect.as("handed_back" as const))),
          Effect.catchTag("StripeError", () =>
            stripe.retrieveAccount(accountId).pipe(
              Effect.as(false),
              Effect.catchTag("StripeError", (error) => Effect.succeed(unreachable(error))),
              Effect.flatMap((gone) =>
                !gone
                  ? notHandedBack(accountId, "account_reachable_or_unknown")
                  : keyReachesPlatform.pipe(
                      Effect.flatMap((reaches) =>
                        reaches
                          ? release(accountId).pipe(Effect.as("released" as const))
                          : notHandedBack(accountId, "key_reach_unproved"),
                      ),
                    ),
              ),
            ),
          ),
          // A write through `dbQuery` dies rather than fails: a defect here
          // ends this account's step, never the run.
          Effect.catchCause((cause) =>
            Effect.logError("stripe account hand-back failed").pipe(
              Effect.annotateLogs({
                stripeAccountId: accountId,
                cause: Cause.pretty(cause).split("\n")[0] ?? "",
              }),
              Effect.as("failed" as const),
            ),
          ),
        );

      const result: HandBackRunResult = { handedBack: 0, released: 0, failed: 0, more };
      for (const { accountId } of due.slice(0, HAND_BACKS_PER_RUN)) {
        const outcome = yield* handBack(accountId);
        if (outcome === "handed_back") result.handedBack += 1;
        else if (outcome === "released") result.released += 1;
        else result.failed += 1;
      }
      yield* Effect.sync(() => {
        metricRegistryStripeHandBack("handed_back", result.handedBack);
        metricRegistryStripeHandBack("released", result.released);
        metricRegistryStripeHandBack("failed", result.failed);
      });
      yield* Effect.logInfo("retired stripe account hand-back sweep complete", { ...result });
      return result;
    }).pipe(Effect.withSpan("cire.maintenance.handBackRetiredAccounts"));
  },
};
