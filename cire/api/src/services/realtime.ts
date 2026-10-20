import { realtimeSubscribeBudget } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { publish, type HubNamespace } from "@shared/realtime/server";
import { lt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { commitBatchResults, DbService } from "../db";
import { getWaitUntil } from "../lib/execution-ctx";
import { runCire } from "../observability";

/** The topic every open tab showing one wedding listens on. */
export const weddingTopic = (weddingId: string): string => `cire:wedding:${weddingId}`;

export interface WeddingSignals {
  /**
   * The wedding's seats changed. Call after the write has committed.
   * `revoked` names the members who lost the dashboard: the hub sends them the
   * signal, then closes their sockets with 1008, so their tabs re-read once and
   * stop listening instead of reconnecting to be refused. `request` is the
   * write's own request: when the Worker registered an execution context for
   * it, the publish runs after the response in `waitUntil`, so the write never
   * waits on the hub. Never fails.
   */
  membersChanged(
    weddingId: string,
    request: Request,
    revoked?: readonly string[],
  ): Effect.Effect<void>;
}

export const createWeddingSignals = (hub: HubNamespace | undefined): WeddingSignals => ({
  membersChanged: (weddingId, request, revoked = []) => {
    const work = publish(hub, weddingTopic(weddingId), "members-changed", {
      revokeSubjects: revoked,
    });
    const waitUntil = getWaitUntil(request);
    // Inline with no execution context (unit tests, the local Bun server), and
    // with no hub, where the publish only counts and sends nothing.
    return waitUntil && hub ? Effect.sync(() => waitUntil(runCire(work))) : work;
  },
});

/**
 * Subscribes one organiser may be admitted past the daily ceiling per UTC day.
 * Every admitted subscribe is a Durable Object request from the account-wide
 * Workers Free allowance of 100,000 a day, dev included. An organiser spends
 * one on each mount of a wedding, each return to a tab hidden for more than
 * two ping intervals, each hourly expiry on a wedding that publishes, and each
 * deploy, so a long day of switching tabs stays well inside 300, while a
 * script needs more than 300 accounts to spend the allowance.
 */
export const REALTIME_SUBSCRIBES_PER_DAY = 300;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Spend one of `osnProfileId`'s subscribes for today, in one D1 batch that
 * first deletes earlier days' rows. Answers whether one was left. At the
 * ceiling the upsert changes nothing and returns no row, so a refused attempt
 * reads the row but writes none.
 */
export const spendRealtimeSubscribe = (
  osnProfileId: string,
  perDay: number = REALTIME_SUBSCRIBES_PER_DAY,
  now: Date = new Date(),
) =>
  Effect.gen(function* () {
    if (perDay <= 0) return false;
    const db = yield* DbService;
    const day = utcDay(now);
    const [, spent] = yield* Effect.tryPromise(() =>
      commitBatchResults(db, [
        db.delete(realtimeSubscribeBudget).where(lt(realtimeSubscribeBudget.day, day)),
        db
          .insert(realtimeSubscribeBudget)
          .values({ osnProfileId, day, subscribes: 1 })
          .onConflictDoUpdate({
            target: [realtimeSubscribeBudget.osnProfileId, realtimeSubscribeBudget.day],
            set: { subscribes: sql`${realtimeSubscribeBudget.subscribes} + 1` },
            setWhere: lt(realtimeSubscribeBudget.subscribes, perDay),
          })
          .returning({ subscribes: realtimeSubscribeBudget.subscribes }),
      ]),
    );
    return (spent as readonly unknown[]).length > 0;
  });

/**
 * Delete the budget rows of every day before `now`'s, for the daily cron. A
 * subscribe deletes them too, but nothing subscribes while push is off, and
 * the rows name organisers. Answers how many went.
 */
export const sweepRealtimeSubscribeBudget = (now: Date = new Date()) =>
  Effect.gen(function* () {
    const db = yield* DbService;
    const result = yield* Effect.tryPromise(() =>
      Promise.resolve(
        db
          .delete(realtimeSubscribeBudget)
          .where(lt(realtimeSubscribeBudget.day, utcDay(now)))
          .run(),
      ),
    );
    const deleted = rowsChanged(result);
    yield* Effect.logInfo("realtime subscribe budget sweep complete", { deleted });
    return deleted;
  }).pipe(Effect.withSpan("cire.realtime.sweepSubscribeBudget"));
