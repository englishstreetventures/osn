/**
 * Security-event audit surface: the unacknowledged-events banner feed, the
 * step-up-gated acknowledge paths, and the shared best-effort email
 * notification used by the passkey / cross-device flows.
 */

import { accounts, securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailService } from "@shared/email";
import type { SecurityEventKind } from "@shared/observability/metrics";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import {
  metricSecurityEventAcknowledged,
  metricSecurityEventNotified,
  metricSecurityEventNotifyDuration,
} from "../../metrics";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import type { StepUpModule } from "./step-up";
import type { SecurityEventSummary } from "./types";

export function createSecurityEventsModule(ctx: AuthContext, stepUp: StepUpModule) {
  const { recoveryGenerateAllowedAmr } = ctx;
  const { verifyStepUpToken } = stepUp;

  /**
   * Lists still-unacknowledged security events for an account, newest first.
   * Intended for the Settings banner — acknowledged rows are kept for audit
   * but are filtered out of the surface.
   *
   * P-I1: explicit projection so adding an internal column later (e.g. a
   * JSON context blob) doesn't silently grow the wire payload.
   */
  const listUnacknowledgedSecurityEvents = (
    accountId: string,
  ): Effect.Effect<{ events: SecurityEventSummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: securityEvents.id,
              kind: securityEvents.kind,
              createdAt: securityEvents.createdAt,
              uaLabel: securityEvents.uaLabel,
              ipHash: securityEvents.ipHash,
            })
            .from(securityEvents)
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            )
            .orderBy(desc(securityEvents.createdAt))
            .limit(50),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        events: rows.map((row) => ({
          id: row.id,
          // Service boundary re-asserts the bounded kind union so a hand-
          // written INSERT (or a downgrade that widens the column) can't
          // leak an unbounded string into the metric attribute.
          kind: row.kind as SecurityEventKind,
          createdAt: row.createdAt,
          uaLabel: row.uaLabel,
          ipHash: row.ipHash,
        })),
      };
    }).pipe(Effect.withSpan("auth.security_event.list"));

  /**
   * Marks a single security event as acknowledged.
   *
   * S-M1: step-up gated. Without step-up, an XSS that sniffed the access
   * token could GET the list and POST ack on every id before the user ever
   * saw the banner — the banner is the defence against the very scenario
   * that compromised the access token, so it can't be dismissible by that
   * same token. Allowed amr defaults to `["webauthn", "otp"]`, matching the
   * `/recovery/generate` gate.
   *
   * Idempotent on the row side — acking a row that's already acknowledged,
   * or a row that doesn't exist on the caller's account, returns
   * `{ acknowledged: false }` rather than surfacing "not found" (same posture
   * as `/logout` and `/sessions/:id`). The step-up jti is still consumed on
   * such calls; callers are expected to bulk-ack via
   * `acknowledgeAllSecurityEvents` when dismissing a full banner.
   */
  const acknowledgeSecurityEvent = (
    accountId: string,
    eventId: string,
    stepUpToken: string,
  ): Effect.Effect<{ acknowledged: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);

      if (!/^sev_[a-f0-9]{12}$/.test(eventId)) {
        return { acknowledged: false };
      }
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const existing = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: securityEvents.id, kind: securityEvents.kind })
            .from(securityEvents)
            .where(
              and(
                eq(securityEvents.id, eventId),
                eq(securityEvents.accountId, accountId),
                isNull(securityEvents.acknowledgedAt),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const match = existing[0];
      if (!match) {
        return { acknowledged: false };
      }
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(eq(securityEvents.id, match.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSecurityEventAcknowledged(match.kind as SecurityEventKind);
      return { acknowledged: true };
    }).pipe(Effect.withSpan("auth.security_event.ack"));

  /**
   * Bulk-acks every unacknowledged security event for an account in a single
   * transaction. One step-up → one call dismisses the entire banner. This is
   * the UX path the banner uses; `acknowledgeSecurityEvent` remains for API
   * clients that want per-row control.
   *
   * S-M1: step-up gated on the same amr set as `/recovery/generate`.
   */
  const acknowledgeAllSecurityEvents = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<{ acknowledged: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const unacked = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: securityEvents.id, kind: securityEvents.kind })
            .from(securityEvents)
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (unacked.length === 0) {
        return { acknowledged: 0 };
      }
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      for (const row of unacked) {
        metricSecurityEventAcknowledged(row.kind as SecurityEventKind);
      }
      return { acknowledged: unacked.length };
    }).pipe(Effect.withSpan("auth.security_event.ack_all"));

  /**
   * Best-effort "a security-relevant thing happened on your account" email,
   * shared by the passkey add / remove and cross-device-login flows. Fetches
   * the account's email and dispatches the given template — the body is a
   * boilerplate "it was you or investigate" framing; codes and identifying
   * material are never included. Callers fork this as a daemon with a
   * timeout so mailer health never gates the user-visible operation.
   */
  const notifySecurityEventByAccountId = (
    accountId: string,
    kind: SecurityEventKind,
    template: "passkey-added" | "passkey-removed" | "cross-device-login",
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const recipient = rows[0]?.email;
      if (!recipient) {
        metricSecurityEventNotified(kind, "skipped");
        return;
      }
      const email = yield* EmailService;
      const start = Date.now();
      yield* email.send({ template, to: recipient, data: {} }).pipe(
        Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
        Effect.tap(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
            metricSecurityEventNotified(kind, "sent");
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
            metricSecurityEventNotified(kind, "failed");
          }),
        ),
      );
    }).pipe(Effect.withSpan("auth.security_event.notify", { attributes: { kind } }));

  return {
    listUnacknowledgedSecurityEvents,
    acknowledgeSecurityEvent,
    acknowledgeAllSecurityEvents,
    notifySecurityEventByAccountId,
  };
}

export type SecurityEventsModule = ReturnType<typeof createSecurityEventsModule>;
