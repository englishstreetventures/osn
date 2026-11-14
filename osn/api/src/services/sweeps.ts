/**
 * The sweeps the Bun server runs on its interval (`local.ts`), one after
 * another. The Worker runs the same sweeps from its cron `scheduled` handler,
 * each in its own `waitUntil` (`index.ts`).
 */

import type { Db } from "@osn/db/service";
import { Cause, Effect } from "effect";

import { safeErrorSummary } from "../metrics";
import { runFanOutRetrySweep, runHardDeleteSweep } from "./account-erasure";
import { runExpiredAuthCodeSweep } from "./auth/oidc";
import { runRotatedSessionSweep } from "./auth/tokens";
import { runEmailChangeSweep, runHandleHoldSweep, runSecurityEventSweep } from "./retention";

/** Runs `sweep`; its failure, a defect included, is logged as `failed` and never fails the chain. */
const isolated = <A, E>(failed: string, sweep: Effect.Effect<A, E, Db>) =>
  sweep.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(failed, safeErrorSummary(Cause.squash(cause)))),
  );

/**
 * One pass of every sweep, in order: the deletion fan-out retry, the hard
 * delete, expired OIDC codes, rotated sessions, then the security-event,
 * email-change and handle-hold retention sweeps. A sweep that fails is logged
 * and the next one still runs, so one broken sweep never stops the hard
 * delete or a retention sweep after it.
 *
 * `fanoutUrls` are the Pulse and Zap bases the fan-out calls; unset, the
 * fan-out uses the local dev ports.
 */
export const runLocalSweeps = (fanoutUrls: {
  readonly pulseApiUrl?: string;
  readonly zapApiUrl?: string;
}): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    yield* isolated("fan-out retry sweep failed", runFanOutRetrySweep(fanoutUrls));
    yield* isolated("hard-delete sweep failed", runHardDeleteSweep());
    yield* isolated("OIDC code sweep failed", runExpiredAuthCodeSweep());
    yield* isolated("rotated-session sweep failed", runRotatedSessionSweep());
    yield* isolated("security-event sweep failed", runSecurityEventSweep());
    yield* isolated("email-change sweep failed", runEmailChangeSweep());
    yield* isolated("handle-hold sweep failed", runHandleHoldSweep());
  });
