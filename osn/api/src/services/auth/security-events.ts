/**
 * Security-event audit surface: the unacknowledged-events banner feed, the
 * step-up-gated acknowledge paths, and the shared best-effort email
 * notification used by the passkey, TOTP, cross-device, recovery-factor and
 * email-change flows.
 */

import { accounts, securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { type EmailTemplateData, EmailService, type SendEmailInput } from "@shared/email";
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

/**
 * The templates {@link SecurityEventsModule.notifySecurityEventByAccountId}
 * and {@link SecurityEventsModule.notifySecurityEventTo} will send. A closed
 * list rather than `EmailTemplate`, so neither helper can ever be pointed at
 * an OTP template and mail a code.
 */
type SecurityNoticeTemplate =
  | "passkey-added"
  | "passkey-removed"
  | "totp-enrolled"
  | "totp-disabled"
  | "cross-device-login"
  | "recovery-used"
  | "email-changed";

export function createSecurityEventsModule(ctx: AuthContext, stepUp: StepUpModule) {
  const { config, recoveryGenerateAllowedAmr } = ctx;
  const { verifyStepUpToken } = stepUp;

  /**
   * Lists still-unacknowledged security events for an account, newest first.
   * Intended for the Settings banner — acknowledged rows are kept for audit
   * but are filtered out of the surface.
   *
   * Explicit projection, so adding an internal column later (e.g. a JSON
   * context blob) doesn't silently grow the wire payload.
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
   * Step-up gated. Without step-up, an XSS that sniffed the access
   * token could GET the list and POST ack on every id before the user ever
   * saw the banner — the banner is the defence against the very scenario
   * that compromised the access token, so it can't be dismissible by that
   * same token. The allowed amr set is `recoveryGenerateAllowedAmr`, the
   * `/recovery/generate` gate's.
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
      yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        recoveryGenerateAllowedAmr,
        "security_event_ack",
      );

      if (!/^sev_[a-f0-9]{12}$/.test(eventId)) {
        return { acknowledged: false };
      }
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      // One statement, guarded on the row still being unacknowledged: of two
      // acks at once, only the one whose write changed the row reports it,
      // and the first acknowledgement time stands.
      const changed = yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(
              and(
                eq(securityEvents.id, eventId),
                eq(securityEvents.accountId, accountId),
                isNull(securityEvents.acknowledgedAt),
              ),
            )
            .returning({ kind: securityEvents.kind }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const match = changed[0];
      if (!match) {
        return { acknowledged: false };
      }
      metricSecurityEventAcknowledged(match.kind as SecurityEventKind);
      return { acknowledged: true };
    }).pipe(Effect.withSpan("auth.security_event.ack"));

  /**
   * Bulk-acks every unacknowledged security event for an account in one
   * statement, and reports and counts the rows that statement changed. One
   * step-up → one call dismisses the entire banner. This is
   * the UX path the banner uses; `acknowledgeSecurityEvent` remains for API
   * clients that want per-row control.
   *
   * Step-up gated on the same amr set as `/recovery/generate`.
   */
  const acknowledgeAllSecurityEvents = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<{ acknowledged: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        recoveryGenerateAllowedAmr,
        "security_event_ack",
      );

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const acked = yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            )
            .returning({ kind: securityEvents.kind }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      for (const row of acked) {
        metricSecurityEventAcknowledged(row.kind as SecurityEventKind);
      }
      return { acknowledged: acked.length };
    }).pipe(Effect.withSpan("auth.security_event.ack_all"));

  /**
   * Sends `template` to `recipient` and counts the outcome. The body is a
   * boilerplate "it was you or investigate" framing; codes are never
   * included. A send failure becomes `notify_dispatch_failed`, with the
   * provider's response (which may echo the recipient) left out.
   */
  const dispatch = <T extends SecurityNoticeTemplate>(
    recipient: string,
    kind: SecurityEventKind,
    template: T,
    data: Omit<EmailTemplateData<T>, "instanceName">,
  ): Effect.Effect<void, AuthError, EmailService> =>
    Effect.gen(function* () {
      const email = yield* EmailService;
      const start = Date.now();
      // `SendEmailInput` is a discriminated union over `template`, and TypeScript
      // will not narrow it from an unresolved generic — the pair is correct by
      // the signature above (`data` typed against `T`, less the instance name
      // added here), which is where the check that matters happens. Narrowed
      // here so the union is reconstructed rather than widened away.
      const input = {
        template,
        to: recipient,
        data: { ...data, instanceName: config.instanceName },
      } as SendEmailInput;
      yield* email.send(input).pipe(
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
    });

  /**
   * Best-effort "a security-relevant thing happened on your account" email,
   * shared by the passkey add / remove, TOTP, cross-device-login and
   * recovery-factor flows. Fetches the account's email and dispatches the
   * given template. Callers fork this as a daemon with a timeout so mailer
   * health never gates the user-visible operation.
   */
  const notifySecurityEventByAccountId = <T extends SecurityNoticeTemplate>(
    accountId: string,
    kind: SecurityEventKind,
    template: T,
    /**
     * The template's own data, less the instance name, which this helper adds
     * from `config`. Most notices are boilerplate and pass `{}`;
     * `recovery-used` carries the "this wasn't me" URL. Typed against the
     * template so a caller cannot pass the wrong bag or forget a required one.
     */
    data: Omit<EmailTemplateData<T>, "instanceName">,
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
      yield* dispatch(recipient, kind, template, data);
    }).pipe(Effect.withSpan("auth.security_event.notify", { attributes: { kind } }));

  /**
   * The same notice, sent to an address the caller names instead of the one
   * the account holds now: for the email-change notice, whose recipient is
   * the address the change replaced. Forked like its sibling.
   */
  const notifySecurityEventTo = <T extends SecurityNoticeTemplate>(
    recipient: string,
    kind: SecurityEventKind,
    template: T,
    data: Omit<EmailTemplateData<T>, "instanceName">,
  ): Effect.Effect<void, AuthError, EmailService> =>
    dispatch(recipient, kind, template, data).pipe(
      Effect.withSpan("auth.security_event.notify", { attributes: { kind } }),
    );

  return {
    listUnacknowledgedSecurityEvents,
    acknowledgeSecurityEvent,
    acknowledgeAllSecurityEvents,
    notifySecurityEventByAccountId,
    notifySecurityEventTo,
  };
}

export type SecurityEventsModule = ReturnType<typeof createSecurityEventsModule>;
