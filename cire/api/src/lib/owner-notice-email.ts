/**
 * Emails a wedding's owners when one of them changes who owns it.
 *
 * Every owner acts alone: any owner may remove or demote another, step down,
 * or delete the wedding. Two notices tell the others:
 *
 *  - an owner removed or demoted (`wedding-owner-change`) goes to the person
 *    affected, the owner who did it, and every other remaining owner;
 *  - a delete (`wedding-delete-started`) goes to every owner except the one
 *    who deleted, with the restore deadline.
 *
 * Each names who acted. The actor gets their own copy because a session
 * someone else is using is exactly the case where the real owner needs to
 * see what was done in their name.
 *
 * Fail-soft throughout: the write has committed before this runs, and a notice
 * that cannot be sent (no address, osn-api down, Resend down) is logged and
 * counted, never returned to the caller. A per-wedding throttle keeps a
 * promote/demote loop from spending the mail provider's daily allowance.
 */

import { weddingHosts, weddings } from "@cire/db";
import { EmailService } from "@shared/email";
import type { EmailTemplateData, SendEmailInput } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect, type Layer } from "effect";

import { DbService, dbQuery } from "../db";
import { metricOwnerNotice } from "../metrics";
import type { OwnerNoticeKind, OwnerNoticeResult } from "../metrics";
import { runCire } from "../observability";
import type { HostRole } from "../services/hosts";
import type { OsnOrganiserEmailLookup, OsnProfileDisplayResolver } from "../services/osn-bridge";
import { getWaitUntil } from "./execution-ctx";

/** Owner notices one wedding may send per {@link OWNER_NOTICE_WINDOW_MS}. */
export const OWNER_NOTICES_PER_WEDDING = 10;
export const OWNER_NOTICE_WINDOW_MS = 60 * 60 * 1000;

export interface OwnerNoticeDeps {
  /** osn-api's address lookup; keeps "osn-api did not answer" apart from "no address". */
  readonly lookup: OsnOrganiserEmailLookup;
  /** Names the actor and the subject. Absent or failing ⇒ a generic name. */
  readonly resolveDisplays?: OsnProfileDisplayResolver;
  readonly emailLayer: Layer.Layer<EmailService>;
  /** The organiser portal, linked from every notice. */
  readonly portalUrl: string;
  /** Keyed by wedding id. */
  readonly throttle: RateLimiterBackend;
}

export interface OwnerChangedInput {
  readonly weddingId: string;
  /** Who made the change. */
  readonly actorOsnProfileId: string;
  /** The owner removed or demoted; the actor too when they stepped down. */
  readonly subjectOsnProfileId: string;
  readonly change: "removed" | "demoted";
  /** The role a demoted owner now holds. */
  readonly newRole?: HostRole;
}

export interface DeleteStartedInput {
  readonly weddingId: string;
  readonly actorOsnProfileId: string;
  readonly restoreUntil: Date;
  /** The restore window in days. */
  readonly restoreDays: number;
}

type Audience = EmailTemplateData<"wedding-owner-change">["audience"];

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

/** e.g. "9 October 2026, 14:05 UTC". */
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
   * The shared tail: throttle, look up, build one email per distinct address
   * (first recipient listed wins), send, count. Never fails.
   */
  const deliver = (
    kind: OwnerNoticeKind,
    weddingId: string,
    build: () => Effect.Effect<
      { recipients: Recipient[]; named: string[]; render: RenderFor } | null,
      never,
      DbService
    >,
  ): Effect.Effect<void, never, DbService> =>
    Effect.gen(function* () {
      const allowed = yield* Effect.promise(async () => deps.throttle.check(weddingId));
      if (!allowed) return "throttled" as const;

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
      yield* Effect.annotateCurrentSpan({ recipients: inputs.length });

      yield* sendAll(inputs);
      return "sent" as const;
    }).pipe(
      Effect.catchCause(() => Effect.succeed("failed" as const)),
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
    /** An owner was removed or demoted. */
    ownerChanged(input: OwnerChangedInput): Effect.Effect<void, never, DbService> {
      return deliver("owner_change", input.weddingId, () =>
        Effect.gen(function* () {
          const wedding = yield* weddingOwners(input.weddingId);
          if (!wedding) return null;
          const self = input.actorOsnProfileId === input.subjectOsnProfileId;
          const recipients: Recipient[] = [
            { osnProfileId: input.subjectOsnProfileId, audience: "subject" },
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
      return deliver("delete_started", input.weddingId, () =>
        Effect.gen(function* () {
          const wedding = yield* weddingOwners(input.weddingId);
          if (!wedding) return null;
          const recipients: Recipient[] = wedding.owners
            .filter((id) => id !== input.actorOsnProfileId)
            .map((osnProfileId) => ({ osnProfileId, audience: "owner" }));
          const restoreUntil = formatRestoreUntil(input.restoreUntil);
          const render: RenderFor = (_recipient, to, displays) => ({
            template: "wedding-delete-started",
            to,
            data: {
              weddingName: wedding.name,
              actorName: nameOf(displays, input.actorOsnProfileId),
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
