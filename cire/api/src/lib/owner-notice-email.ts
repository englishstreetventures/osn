/**
 * Emails a wedding's owners when one of them changes who owns it.
 *
 * Every owner acts alone: any owner may make someone an owner, remove or
 * demote another, step down, or delete the wedding. Two notices tell the
 * others:
 *
 *  - an owner added, promoted, removed or demoted (`wedding-owner-change`)
 *    goes to the owner who did it and every other owner, and — for a removal
 *    or demotion — to the person affected;
 *  - a delete (`wedding-delete-started`) goes to every owner, the one who
 *    deleted included, with the restore deadline.
 *
 * Each names who acted. The actor gets their own copy because a session
 * someone else is using is exactly the case where the real owner needs to
 * see what was done in their name.
 *
 * The person affected is not mailed when the actor seated them less than
 * {@link FRESH_SEAT_MS} ago, nor when they were just added or promoted: any
 * owner can seat any OSN user without asking, so mailing a fresh seat would
 * let an owner send Cire-branded mail, carrying a wedding name they wrote, to
 * anyone. The other owners are still told.
 *
 * Fail-soft throughout: the write has committed before this runs, and a notice
 * that cannot be sent (no address, osn-api down, Resend down) is logged and
 * counted, never returned to the caller.
 *
 * An email budget keyed both by wedding and by the owner who acted bounds how
 * much mail one person can cause per UTC day. It counts emails, not notices,
 * because one notice reaches every owner; a promote/demote loop or a wedding
 * stacked with owners then runs out of budget rather than spending the mail
 * provider's daily allowance, which the platform's sign-in codes share. It
 * lives in D1 (`owner_notice_budget`), so every Worker isolate reads the same
 * count, and a fresh wedding does not reset the acting owner's. A delete
 * notice spends only the actor's budget, so a wedding's owners cannot be kept
 * from hearing of its deletion by spending the wedding's budget first.
 */

import { ownerNoticeBudget, weddingHosts, weddings } from "@cire/db";
import { EmailService } from "@shared/email";
import type { EmailTemplateData, SendEmailInput } from "@shared/email";
import { and, eq, lt, sql } from "drizzle-orm";
import { Cause, Effect, type Layer } from "effect";

import { commitBatchResults, DbService, dbQuery } from "../db";
import { metricOwnerNotice } from "../metrics";
import type { OwnerNoticeKind, OwnerNoticeResult } from "../metrics";
import { runCire } from "../observability";
import type { HostRole } from "../services/hosts";
import type { OsnOrganiserEmailLookup, OsnProfileDisplayResolver } from "../services/osn-bridge";
import { getWaitUntil } from "./execution-ctx";

/** Owner-notice emails one wedding, or one acting owner, may cause per UTC
 *  day. A real ownership change mails a handful of people; this is room for
 *  several on one day. */
export const OWNER_NOTICE_EMAILS_PER_DAY = 30;

/** A seat the actor created this recently does not mail its holder. */
export const FRESH_SEAT_MS = 24 * 60 * 60 * 1000;

export interface OwnerNoticeDeps {
  /** osn-api's address lookup; keeps "osn-api did not answer" apart from "no address". */
  readonly lookup: OsnOrganiserEmailLookup;
  /** Names the actor and the subject. Absent or failing ⇒ a generic name. */
  readonly resolveDisplays?: OsnProfileDisplayResolver;
  readonly emailLayer: Layer.Layer<EmailService>;
  /** The organiser portal, linked from every notice. */
  readonly portalUrl: string;
  /** Emails per key per UTC day; defaults to {@link OWNER_NOTICE_EMAILS_PER_DAY}. */
  readonly emailsPerDay?: number;
}

export interface OwnerChangedInput {
  readonly weddingId: string;
  /** Who made the change. */
  readonly actorOsnProfileId: string;
  /** The seat changed; the actor's own when they stepped down or left. */
  readonly subjectOsnProfileId: string;
  readonly change: "added" | "promoted" | "removed" | "demoted";
  /** The role a demoted owner now holds. */
  readonly newRole?: HostRole;
  /** Who created the subject's seat, and when — what decides whether the
   *  subject is mailed. */
  readonly subjectSeat?: { readonly addedByOsnProfileId: string; readonly createdAt: Date };
  /** Defaults to now; a test passes a fixed clock. */
  readonly now?: Date;
}

export interface DeleteStartedInput {
  readonly weddingId: string;
  readonly actorOsnProfileId: string;
  readonly restoreUntil: Date;
  /** The restore window in days. */
  readonly restoreDays: number;
}

type Audience = EmailTemplateData<"wedding-owner-change">["audience"];

/** Whether the person whose seat changed hears of it themselves. Never for an
 *  add or a promotion; never for a seat the actor created in the last
 *  {@link FRESH_SEAT_MS}; otherwise yes. */
function mailsSubject(input: OwnerChangedInput): boolean {
  if (input.change === "added" || input.change === "promoted") return false;
  if (input.actorOsnProfileId === input.subjectOsnProfileId) return true;
  const seat = input.subjectSeat;
  if (!seat || seat.addedByOsnProfileId !== input.actorOsnProfileId) return true;
  const now = input.now ?? new Date();
  return now.getTime() - seat.createdAt.getTime() >= FRESH_SEAT_MS;
}

/** `YYYY-MM-DD` in UTC. */
const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** One recipient of a notice, before their address is known. */
interface Recipient {
  readonly osnProfileId: string;
  readonly audience: Audience;
}

/** `Display Name (@handle)`, `@handle`, or `null` when OSN could not say. */
function nameOf(
  displays: ReadonlyMap<string, { handle: string; displayName: string | null }>,
  osnProfileId: string,
): string | null {
  const display = displays.get(osnProfileId);
  if (!display) return null;
  return display.displayName ? `${display.displayName} (@${display.handle})` : `@${display.handle}`;
}

const RESTORE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** e.g. "9 October 2026 at 14:05 UTC". */
export function formatRestoreUntil(at: Date): string {
  return `${RESTORE_FORMAT.format(at)} UTC`;
}

/** The wedding's name and its owners as they stand now, in one query. Reads a
 *  soft-deleted wedding too: the delete notice is sent after the delete. */
function weddingOwners(
  weddingId: string,
): Effect.Effect<{ name: string; owners: string[] } | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ name: weddings.displayName, owner: weddingHosts.osnProfileId })
        .from(weddings)
        .leftJoin(
          weddingHosts,
          and(eq(weddingHosts.weddingId, weddings.id), eq(weddingHosts.role, "owner")),
        )
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    const [first] = rows;
    if (!first) return null;
    return {
      name: first.name,
      owners: rows.flatMap((r) => (r.owner === null ? [] : [r.owner])),
    };
  });
}

export function createOwnerNotices(deps: OwnerNoticeDeps) {
  const perDay = deps.emailsPerDay ?? OWNER_NOTICE_EMAILS_PER_DAY;

  /**
   * Spend up to `wanted` emails from every key's budget for today and return
   * how many may be sent: one batch that clears earlier days and adds `wanted`
   * to each key, reading each total back. A key's allowance is what was left
   * before this call; the notice sends the smallest. Counting what was asked
   * for, not what was sent, can only make the budget stricter.
   */
  const spend = (keys: readonly string[], wanted: number, now: Date) =>
    Effect.gen(function* () {
      const db = yield* DbService;
      const day = utcDay(now);
      const results = yield* Effect.tryPromise(() =>
        commitBatchResults(db, [
          db.delete(ownerNoticeBudget).where(lt(ownerNoticeBudget.day, day)),
          ...keys.map((key) =>
            db
              .insert(ownerNoticeBudget)
              .values({ key, day, sent: wanted })
              .onConflictDoUpdate({
                target: [ownerNoticeBudget.key, ownerNoticeBudget.day],
                set: { sent: sql`${ownerNoticeBudget.sent} + ${wanted}` },
              })
              .returning({ sent: ownerNoticeBudget.sent }),
          ),
        ]),
      );
      const totals = results.slice(1).map((r) => (r as readonly { sent: number }[])[0]?.sent ?? 0);
      return Math.max(0, Math.min(wanted, ...totals.map((total) => perDay - (total - wanted))));
    });

  /** Addresses and names for these people, asked of osn-api at the same time. */
  const resolve = (recipients: readonly string[], named: readonly string[]) =>
    Effect.all(
      [
        Effect.promise(() => deps.lookup(recipients)),
        deps.resolveDisplays
          ? Effect.tryPromise(() => deps.resolveDisplays!(named)).pipe(
              Effect.orElseSucceed(() => new Map()),
            )
          : Effect.succeed(new Map()),
      ],
      { concurrency: 2 },
    );

  /** Sends every input in one provider call where the transport allows it. */
  const sendAll = (inputs: readonly SendEmailInput[]) =>
    Effect.gen(function* () {
      const email = yield* EmailService;
      if (email.sendBatch) {
        yield* email.sendBatch(inputs);
        return;
      }
      yield* Effect.forEach(inputs, (input) => email.send(input), {
        concurrency: 4,
        discard: true,
      });
    }).pipe(Effect.provide(deps.emailLayer));

  /**
   * The shared tail: look up, build one email per distinct address (first
   * recipient listed wins), spend the email budget, send, count. Never fails.
   */
  const deliver = (
    kind: OwnerNoticeKind,
    weddingId: string,
    actorOsnProfileId: string,
    now: Date,
    build: () => Effect.Effect<
      { recipients: Recipient[]; named: string[]; render: RenderFor } | null,
      never,
      DbService
    >,
  ): Effect.Effect<void, never, DbService> =>
    Effect.gen(function* () {
      const plan = yield* build();
      if (!plan || plan.recipients.length === 0) return "no_recipients" as const;

      const [answer, displays] = yield* resolve(
        plan.recipients.map((r) => r.osnProfileId),
        plan.named,
      );
      if (!answer.answered && answer.emails.size === 0) return "failed" as const;

      const seen = new Set<string>();
      const inputs: SendEmailInput[] = [];
      for (const recipient of plan.recipients) {
        const to = answer.emails.get(recipient.osnProfileId);
        if (!to || seen.has(to.toLowerCase())) continue;
        seen.add(to.toLowerCase());
        inputs.push(plan.render(recipient, to, displays));
      }
      if (inputs.length === 0) return "no_recipients" as const;

      // The budget is spent in recipient order, so the person affected is
      // mailed first and a short budget runs out on the owners at the end.
      const keys =
        kind === "delete_started"
          ? [`actor:${actorOsnProfileId}`]
          : [`wedding:${weddingId}`, `actor:${actorOsnProfileId}`];
      const allowed = yield* spend(keys, inputs.length, now);
      const budgeted = inputs.slice(0, allowed);
      if (budgeted.length === 0) return "throttled" as const;
      yield* Effect.annotateCurrentSpan({
        recipients: budgeted.length,
        over_budget: inputs.length - budgeted.length,
      });

      yield* sendAll(budgeted);
      return "sent" as const;
    }).pipe(
      Effect.catchCause((cause) =>
        // The failure's tag only: an address or a provider message never
        // reaches the log.
        Effect.logWarning("owner notice failed").pipe(
          Effect.annotateLogs({ weddingId, kind, error: errorTag(Cause.squash(cause)) }),
          Effect.as("failed" as const),
        ),
      ),
      Effect.tap((result: OwnerNoticeResult) =>
        Effect.sync(() => metricOwnerNotice(kind, result)).pipe(
          Effect.andThen(
            result === "sent"
              ? Effect.void
              : Effect.logWarning("owner notice not sent").pipe(
                  Effect.annotateLogs({ weddingId, kind, result }),
                ),
          ),
        ),
      ),
      Effect.asVoid,
      Effect.withSpan(`cire.ownerNotice.${kind}`),
    );

  return {
    /** An owner was added, promoted, removed or demoted. */
    ownerChanged(input: OwnerChangedInput): Effect.Effect<void, never, DbService> {
      const now = input.now ?? new Date();
      return deliver("owner_change", input.weddingId, input.actorOsnProfileId, now, () =>
        Effect.gen(function* () {
          const wedding = yield* weddingOwners(input.weddingId);
          if (!wedding) return null;
          const self = input.actorOsnProfileId === input.subjectOsnProfileId;
          const recipients: Recipient[] = [
            ...(mailsSubject(input)
              ? [{ osnProfileId: input.subjectOsnProfileId, audience: "subject" as const }]
              : []),
            ...(self
              ? []
              : [{ osnProfileId: input.actorOsnProfileId, audience: "actor" as const }]),
            ...wedding.owners
              .filter((id) => id !== input.subjectOsnProfileId && id !== input.actorOsnProfileId)
              .map((osnProfileId) => ({ osnProfileId, audience: "owner" as const })),
          ];
          const render: RenderFor = (recipient, to, displays) => ({
            template: "wedding-owner-change",
            to,
            data: {
              weddingName: wedding.name,
              actorName: nameOf(displays, input.actorOsnProfileId),
              subjectName: nameOf(displays, input.subjectOsnProfileId),
              change: input.change,
              newRole: input.newRole,
              audience: recipient.audience,
              self,
              portalUrl: deps.portalUrl,
            },
          });
          return {
            recipients,
            named: [input.actorOsnProfileId, input.subjectOsnProfileId],
            render,
          };
        }),
      );
    },

    /** An owner started deleting the wedding. */
    deleteStarted(input: DeleteStartedInput): Effect.Effect<void, never, DbService> {
      return deliver("delete_started", input.weddingId, input.actorOsnProfileId, new Date(), () =>
        Effect.gen(function* () {
          const wedding = yield* weddingOwners(input.weddingId);
          if (!wedding) return null;
          // The deleter first: on a one-owner wedding they are the only one who
          // can notice a delete made from a session that is not theirs.
          const recipients: Recipient[] = [
            { osnProfileId: input.actorOsnProfileId, audience: "actor" },
            ...wedding.owners
              .filter((id) => id !== input.actorOsnProfileId)
              .map((osnProfileId) => ({ osnProfileId, audience: "owner" as const })),
          ];
          const restoreUntil = formatRestoreUntil(input.restoreUntil);
          const render: RenderFor = (recipient, to, displays) => ({
            template: "wedding-delete-started",
            to,
            data: {
              weddingName: wedding.name,
              actorName: nameOf(displays, input.actorOsnProfileId),
              audience: recipient.audience === "actor" ? "actor" : "owner",
              restoreUntil,
              restoreDays: input.restoreDays,
              portalUrl: deps.portalUrl,
            },
          });
          return { recipients, named: [input.actorOsnProfileId], render };
        }),
      );
    },
  };
}

/** A failure's `_tag`, or `defect` for anything without one. */
function errorTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { _tag: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return "defect";
}

type RenderFor = (
  recipient: Recipient,
  to: string,
  displays: ReadonlyMap<string, { handle: string; displayName: string | null }>,
) => SendEmailInput;

export type OwnerNotices = ReturnType<typeof createOwnerNotices>;

/**
 * Run a notice after the response, through the Worker's `waitUntil` when the
 * request has one, or inline otherwise (tests, the Bun dev server). Either way
 * it cannot fail the request.
 */
export function dispatchNotice(
  request: Request,
  notice: Effect.Effect<void, never, never>,
): Effect.Effect<void> {
  const waitUntil = getWaitUntil(request);
  if (!waitUntil) return notice;
  return Effect.sync(() => waitUntil(runCire(notice)));
}
