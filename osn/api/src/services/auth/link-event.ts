/**
 * The audit rows an emailed link writes for the account's security banner:
 *
 *  - `recovery_otp_lockout` and `step_up_link_lockout` when the account
 *    crosses the wrong-number threshold on its recovery or step-up links, so
 *    the owner sees repeated failed attempts even though every attempt
 *    answered alike over the wire;
 *  - `recovery_link_declined` when the holder of a recovery link said they
 *    did not ask for it, so the owner's other devices show that someone did;
 *  - `step_up_link_declined` when the holder of a step-up link said they did
 *    not ask: someone signed in to the account asked to act, and the owner
 *    said no.
 *
 * Best-effort and off the response path: the caller forks it, so the answer
 * never waits on it — only a real account gets a row, so an answer that
 * waited on this insert would tell a stopwatch the address is real. A write
 * failure is logged, never answered. Mirrors `recordRecoveryLockoutEvent` in
 * `recovery.ts`.
 */

import { securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect } from "effect";

import { metricSecurityEventRecorded } from "../../metrics";
import type { AuthContext } from "./context";
import { DatabaseError } from "./errors";
import { genId } from "./helpers";
import type { SessionMeta } from "./types";

/** The security event kinds an emailed link writes. */
export type LinkEventKind =
  | "recovery_otp_lockout"
  | "recovery_link_declined"
  | "step_up_link_lockout"
  | "step_up_link_declined";

export const recordLinkEvent = (
  hashIp: AuthContext["hashIp"],
  accountId: string,
  kind: LinkEventKind,
  eventMeta?: SessionMeta,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const nowSec = Math.floor(Date.now() / 1000);
    yield* Effect.tryPromise({
      try: () =>
        db.insert(securityEvents).values({
          id: genId("sev_"),
          accountId,
          kind,
          createdAt: nowSec,
          acknowledgedAt: null,
          ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
          uaLabel: eventMeta?.uaLabel ?? null,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricSecurityEventRecorded(kind))),
      Effect.catch((cause) =>
        Effect.logWarning("auth.email_link.event: audit write failed").pipe(
          Effect.annotateLogs({ kind, error: String(cause) }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("auth.email_link.event"));
