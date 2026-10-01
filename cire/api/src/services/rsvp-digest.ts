/**
 * The daily RSVP change digest: one email per organiser per wedding, on a day
 * guests changed their RSVPs, and only then.
 *
 * Who gets one: every owner of the wedding and every co-host whose role
 * carries the `editor` capability (`policyFor` in `middleware/wedding-role.ts`),
 * less anyone who turned it off for that wedding. What it covers: the changes
 * in `rsvp_changes` past that person's `digest_seq`, counted in households per
 * kind, and for someone with no marker yet only what changed after they were
 * given their seat. It carries no guest name (see the template in
 * `@shared/email`).
 *
 * Built for one shared cron invocation on Workers Free — 50 external
 * subrequests, 50 D1 queries and 10 ms of CPU for every sweep at once:
 *
 *  - six D1 queries whatever the number of recipients (the candidates, three
 *    reads naming them, the changes, one upsert for every marker);
 *  - at most {@link RSVP_DIGEST_MAX_EMAILS_PER_RUN} recipients, which is one
 *    osn-api lookup call and, on Resend, one batch send;
 *  - recipients are taken one wedding at a time, round the weddings, so no
 *    wedding can fill a run while another waits; the rest are counted
 *    `deferred` and come first next run, because the oldest markers go first;
 *  - a recipient's marker moves only when they were mailed or osn-api answered
 *    without an address for them. A failed send or an unanswered lookup moves
 *    nothing, and the next run includes whatever has changed since. Nothing
 *    older than {@link RSVP_DIGEST_LOOKBACK_MS} is ever mailed.
 */

import {
  hostRsvpNotices,
  rsvpChanges,
  weddingHosts,
  weddings,
  type RsvpChangeKind,
} from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { EmailService, type SendEmailInput } from "@shared/email";
import type { RsvpDigestChangeKind } from "@shared/email/templates";
import { and, eq, getTableColumns, gt, gte, inArray, max, sql, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { weddingIsLive } from "../db/live-wedding";
import { deriveDigestStopKey, digestStopUrl, type DigestStopTarget } from "../lib/digest-stop";
import { metricRsvpDigestEmails, type RsvpDigestOutcome } from "../metrics";
import { decideCapability, type WeddingRole } from "../middleware/wedding-role";
import { normaliseHostRole } from "./hosts";
import type { OrganiserEmailAnswer, OsnOrganiserEmailLookup } from "./osn-bridge";
import { rsvpChangeService, type RsvpChangeError } from "./rsvp-changes";

/**
 * Recipients per run. One osn-api lookup call takes 100 ids and one Resend
 * batch call takes 100 emails, so a full run costs two external subrequests
 * of the invocation's shared 50.
 */
export const RSVP_DIGEST_MAX_EMAILS_PER_RUN = 100;

/** How far back a digest reaches. Bounds the reads, and the size of a first digest. */
export const RSVP_DIGEST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export class RsvpDigestError extends Data.TaggedError("RsvpDigestError")<{
  reason: string;
}> {}

export interface RsvpDigestResult {
  sent: number;
  failed: number;
  noAddress: number;
  lookupFailed: number;
  deferred: number;
}

export interface RsvpDigestOptions {
  /** Base of the portal link — the organiser origin from `WEB_ORIGIN`. */
  organiserOrigin: string;
  lookup: OsnOrganiserEmailLookup;
  now?: Date;
  maxEmails?: number;
  /**
   * Where each email's one-click stop link points, and the secret its key is
   * derived from (`lib/digest-stop.ts`) — derived only once a run has someone
   * to mail. Absent ⇒ the emails carry no stop link and no `List-Unsubscribe`
   * header; the Overview switch is then the only way out.
   */
  stopLinks?: { apiOrigin: string; secret: string };
}

/** What a stop link did. `no_seat` — the person no longer holds a seat that
 *  receives the digest, so there was nothing to turn off. */
export type DigestStopOutcome = "stopped" | "no_seat";

interface Recipient {
  weddingId: string;
  osnProfileId: string;
  /** Their `digest_seq`: changes at or below it were mailed already. */
  cursor: number;
  /** Changes before this are not theirs: the look-back, or when their seat began. */
  since: number;
}

interface Mark {
  weddingId: string;
  osnProfileId: string;
  seq: number;
}

interface ChangeGroup {
  weddingId: string;
  familyId: string;
  kind: RsvpChangeKind;
  maxSeq: number;
  /** Epoch ms of the group's newest change. */
  maxAt: number;
}

const EMPTY: RsvpDigestResult = { sent: 0, failed: 0, noAddress: 0, lookupFailed: 0, deferred: 0 };

const noticeKey = (weddingId: string, osnProfileId: string) => `${weddingId}::${osnProfileId}`;

const read = <A>(run: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (e) => new RsvpDigestError({ reason: String(e) }),
  });

/** An aggregated `created_at`: a Date through Drizzle's column, seconds through `max()`. */
const epochMs = (value: Date | number | null): number =>
  value instanceof Date ? value.getTime() : typeof value === "number" ? value * 1000 : 0;

/** May this role receive the digest? The policy table's `editor` capability. */
const receivesDigest = (role: WeddingRole) => decideCapability(role, "editor").allowed;

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pick up to `limit` recipients, one wedding at a time round the weddings.
 * Weddings go in order of their longest-waiting recipient, and each wedding's
 * recipients oldest cursor first, so what is left over goes first next run.
 */
export interface RecipientChoice {
  chosen: Recipient[];
  /** Pending recipients left for a later run. */
  deferred: number;
}

export function chooseRecipients(pending: readonly Recipient[], limit: number): RecipientChoice {
  const byWedding = new Map<string, Recipient[]>();
  for (const recipient of pending) {
    const list = byWedding.get(recipient.weddingId) ?? [];
    list.push(recipient);
    byWedding.set(recipient.weddingId, list);
  }
  const queues = [...byWedding.values()].map((list) =>
    list.toSorted((a, b) => a.cursor - b.cursor || byString(a.osnProfileId, b.osnProfileId)),
  );
  queues.sort((a, b) => a[0]!.cursor - b[0]!.cursor || byString(a[0]!.weddingId, b[0]!.weddingId));

  const chosen: Recipient[] = [];
  for (let round = 0; chosen.length < limit; round++) {
    let took = false;
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      const next = queue[round];
      if (!next) continue;
      chosen.push(next);
      took = true;
    }
    if (!took) break;
  }
  return { chosen, deferred: pending.length - chosen.length };
}

/** Households per kind, and in all, for one recipient's groups. */
function countGroups(groups: readonly ChangeGroup[]) {
  const byKind = new Map<RsvpChangeKind, Set<string>>();
  const households = new Set<string>();
  for (const group of groups) {
    households.add(group.familyId);
    const set = byKind.get(group.kind) ?? new Set<string>();
    set.add(group.familyId);
    byKind.set(group.kind, set);
  }
  const counts: Partial<Record<RsvpDigestChangeKind, number>> = {};
  for (const [kind, families] of byKind) counts[kind] = families.size;
  return { households: households.size, counts };
}

/**
 * One upsert moving every given marker forward, never back. The rows ride as
 * one JSON parameter. A row is written only for someone who still holds a seat
 * on the wedding, so anyone removed while the run was going does not get their
 * row back. A new row takes the defaults a missing row
 * reads as (nothing seen, digest on); an existing row keeps its switch, so a
 * recipient who turned the digest off mid-run stays off. The `WHERE` is also
 * what lets SQLite read the `ON` that follows as the upsert rather than a join.
 */
export function buildMarkStatement(db: Db, marks: readonly Mark[], now: Date) {
  const updatedAt = hostRsvpNotices.updatedAt.mapToDriverValue(now);
  const payload = JSON.stringify(marks.map((m) => [m.weddingId, m.osnProfileId, m.seq]));
  const wedding = sql`json_extract(value, '$[0]')`;
  const profile = sql`json_extract(value, '$[1]')`;
  const columns = {
    weddingId: wedding,
    osnProfileId: profile,
    seenSeq: sql`0`,
    digestSeq: sql`json_extract(value, '$[2]')`,
    digestEnabled: sql`1`,
    updatedAt: sql`${updatedAt}`,
  } satisfies Record<keyof typeof hostRsvpNotices.$inferSelect, SQL>;
  const selectList = Object.keys(getTableColumns(hostRsvpNotices)).map((key) => {
    if (!Object.hasOwn(columns, key)) {
      throw new Error(`host_rsvp_notices column "${key}" has no value`);
    }
    return columns[key as keyof typeof columns];
  });
  const stillOrganiser = sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${wedding} AND ${weddingHosts.osnProfileId} = ${profile})`;
  return db
    .insert(hostRsvpNotices)
    .select(
      sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload}) WHERE ${stillOrganiser}`,
    )
    .onConflictDoUpdate({
      target: [hostRsvpNotices.weddingId, hostRsvpNotices.osnProfileId],
      set: {
        digestSeq: sql`max(${hostRsvpNotices.digestSeq}, excluded.digest_seq)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * The digest's first read: each wedding with a change in the window, its
 * newest seq and newest time. The `+` keeps SQLite from answering the
 * `GROUP BY` by walking the wedding index over the whole 90-day log; with it
 * the read ranges over `rsvp_changes_created_at_idx` (pinned by a plan test).
 */
export function buildCandidateQuery(db: Db, since: Date) {
  return db
    .select({
      weddingId: rsvpChanges.weddingId,
      maxSeq: max(rsvpChanges.seq),
      maxAt: max(rsvpChanges.createdAt),
    })
    .from(rsvpChanges)
    .where(gte(rsvpChanges.createdAt, since))
    .groupBy(sql`+${rsvpChanges.weddingId}`);
}

/**
 * Send every message, and say which went. With a batch-capable transport it is
 * one provider call for the lot, all or nothing; otherwise one send each, four
 * at a time.
 */
function sendAll(
  emailService: EmailService["Service"],
  messages: readonly { key: string; input: SendEmailInput }[],
): Effect.Effect<Set<string>> {
  if (messages.length === 0) return Effect.succeed(new Set());
  const failedWarning = Effect.logWarning("rsvp digest: send failed — retried next run");
  if (emailService.sendBatch) {
    return emailService.sendBatch(messages.map((m) => m.input)).pipe(
      Effect.as(new Set(messages.map((m) => m.key))),
      Effect.catchCause(() =>
        failedWarning.pipe(
          Effect.annotateLogs({ template: "rsvp-change-digest", batch: messages.length }),
          Effect.as(new Set<string>()),
        ),
      ),
    );
  }
  return Effect.forEach(
    messages,
    (message) =>
      emailService.send(message.input).pipe(
        Effect.as([message.key]),
        Effect.catchCause(() =>
          failedWarning.pipe(
            Effect.annotateLogs({ template: "rsvp-change-digest" }),
            Effect.as([] as string[]),
          ),
        ),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((keys) => new Set(keys.flat())));
}

export const rsvpDigestService = {
  sendDailyDigests(
    options: RsvpDigestOptions,
  ): Effect.Effect<RsvpDigestResult, RsvpDigestError, DbService | EmailService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const emailService = yield* EmailService;
      const now = options.now ?? new Date();
      const maxEmails = options.maxEmails ?? RSVP_DIGEST_MAX_EMAILS_PER_RUN;
      const lookback = new Date(now.getTime() - RSVP_DIGEST_LOOKBACK_MS);

      // 1. Weddings with a change in the window, and each one's newest change.
      const candidates = yield* read(() => buildCandidateQuery(db, lookback).all());
      if (candidates.length === 0) return EMPTY;
      const newest = new Map(
        candidates.map((c) => [c.weddingId, { seq: c.maxSeq ?? 0, at: epochMs(c.maxAt) }]),
      );
      const weddingIds = [...newest.keys()];

      // 2. Who might be mailed for them, and where each one's marker stands.
      const [weddingRows, hostRows, noticeRows] = yield* Effect.all(
        [
          read(() =>
            db
              .select({
                id: weddings.id,
                name: weddings.displayName,
              })
              .from(weddings)
              // A soft-deleted wedding is left out, and with it every one of
              // its recipients below.
              .where(and(inArray(weddings.id, jsonEachIn(weddingIds)), weddingIsLive))
              .all(),
          ),
          read(() =>
            db
              .select({
                weddingId: weddingHosts.weddingId,
                osnProfileId: weddingHosts.osnProfileId,
                role: weddingHosts.role,
                createdAt: weddingHosts.createdAt,
              })
              .from(weddingHosts)
              .where(inArray(weddingHosts.weddingId, jsonEachIn(weddingIds)))
              .all(),
          ),
          read(() =>
            db
              .select({
                weddingId: hostRsvpNotices.weddingId,
                osnProfileId: hostRsvpNotices.osnProfileId,
                digestEnabled: hostRsvpNotices.digestEnabled,
                digestSeq: hostRsvpNotices.digestSeq,
              })
              .from(hostRsvpNotices)
              .where(inArray(hostRsvpNotices.weddingId, jsonEachIn(weddingIds)))
              .all(),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const notices = new Map(noticeRows.map((n) => [noticeKey(n.weddingId, n.osnProfileId), n]));
      const names = new Map(weddingRows.map((w) => [w.id, w.name]));
      // Every organiser holds a seat, owners included, so the seats are the
      // whole list of people who might be mailed.
      const people = hostRows.map((h) => ({
        weddingId: h.weddingId,
        osnProfileId: h.osnProfileId,
        role: normaliseHostRole(h.role),
        seatedAt: h.createdAt.getTime(),
      }));
      const pending: Recipient[] = [];
      for (const person of people) {
        if (!names.has(person.weddingId)) continue;
        if (!receivesDigest(person.role)) continue;
        const notice = notices.get(noticeKey(person.weddingId, person.osnProfileId));
        if (notice?.digestEnabled === false) continue;
        const cursor = notice?.digestSeq ?? 0;
        // Someone with no marker yet is owed only what changed after they
        // were seated — which also means a seat removed and added again does
        // not start over with the whole window.
        const since = notice ? lookback.getTime() : Math.max(lookback.getTime(), person.seatedAt);
        const latest = newest.get(person.weddingId);
        if (!latest || cursor >= latest.seq || latest.at < since) continue;
        pending.push({
          weddingId: person.weddingId,
          osnProfileId: person.osnProfileId,
          cursor,
          since,
        });
      }
      const { chosen, deferred } = chooseRecipients(pending, maxEmails);
      if (chosen.length === 0) return EMPTY;

      // 3. The changes those recipients have not had, as (household, kind) groups.
      const chosenWeddings = [...new Set(chosen.map((r) => r.weddingId))];
      const minCursor = Math.min(...chosen.map((r) => r.cursor));
      const groups: ChangeGroup[] = (yield* read(() =>
        db
          .select({
            weddingId: rsvpChanges.weddingId,
            familyId: rsvpChanges.familyId,
            kind: rsvpChanges.kind,
            maxSeq: max(rsvpChanges.seq),
            maxAt: max(rsvpChanges.createdAt),
          })
          .from(rsvpChanges)
          .where(
            and(
              inArray(rsvpChanges.weddingId, jsonEachIn(chosenWeddings)),
              gte(rsvpChanges.createdAt, lookback),
              gt(rsvpChanges.seq, minCursor),
            ),
          )
          .groupBy(rsvpChanges.weddingId, rsvpChanges.familyId, rsvpChanges.kind)
          .all(),
      )).map((g) => ({
        weddingId: g.weddingId,
        familyId: g.familyId,
        kind: g.kind,
        maxSeq: g.maxSeq ?? 0,
        maxAt: epochMs(g.maxAt),
      }));

      // 4. One lookup. If osn-api did not answer, mail nobody and move no
      // marker: the next run asks again. An id missing from an answer has no
      // address, and that recipient's marker moves.
      const answer: OrganiserEmailAnswer = yield* Effect.tryPromise(() =>
        options.lookup([...new Set(chosen.map((r) => r.osnProfileId))]),
      ).pipe(Effect.orElseSucceed(() => ({ answered: false, emails: new Map<string, string>() })));
      if (!answer.answered) {
        const result = { ...EMPTY, lookupFailed: chosen.length, deferred };
        yield* Effect.sync(() => record(result));
        yield* Effect.logWarning("rsvp digest: osn-api did not answer — nothing sent", {
          recipients: chosen.length,
        });
        return result;
      }

      // 5. Build each recipient's email and its marker. Stop links are signed
      // for the recipients with an address, before the plans: a signing
      // failure sends the email without one rather than not at all.
      const stopUrls = yield* signStopLinks(
        options.stopLinks,
        chosen.filter((r) => answer.emails.has(r.osnProfileId)),
      );
      const origin = options.organiserOrigin.replace(/\/+$/, "");
      const plans = chosen.map((recipient) => {
        const mine = groups.filter(
          (g) =>
            g.weddingId === recipient.weddingId &&
            g.maxSeq > recipient.cursor &&
            g.maxAt >= recipient.since,
        );
        const mark: Mark = {
          weddingId: recipient.weddingId,
          osnProfileId: recipient.osnProfileId,
          seq:
            mine.length > 0
              ? Math.max(...mine.map((g) => g.maxSeq))
              : (newest.get(recipient.weddingId)?.seq ?? 0),
        };
        const key = noticeKey(recipient.weddingId, recipient.osnProfileId);
        const to = answer.emails.get(recipient.osnProfileId);
        if (mine.length === 0) return { key, mark, outcome: null, input: null };
        if (!to) return { key, mark, outcome: "no_address" as const, input: null };
        const { households, counts } = countGroups(mine);
        const input: SendEmailInput = {
          template: "rsvp-change-digest",
          to,
          data: {
            weddingName: names.get(recipient.weddingId) ?? "",
            households,
            counts,
            rsvpUrl: `${origin}/#/w/${encodeURIComponent(recipient.weddingId)}/guests/rsvps`,
            stopUrl: stopUrls.get(key),
          },
        };
        return { key, mark, outcome: null, input };
      });

      // 6. Send. A marker moves on a send or a definite "no address", never on
      // a failure.
      const messages = plans.flatMap((p) => (p.input ? [{ key: p.key, input: p.input }] : []));
      const sentKeys = yield* sendAll(emailService, messages);

      const marks = plans.flatMap((p) => (p.input && !sentKeys.has(p.key) ? [] : [p.mark]));
      if (marks.length > 0) yield* read(() => buildMarkStatement(db, marks, now).run());

      const result: RsvpDigestResult = {
        sent: sentKeys.size,
        failed: messages.length - sentKeys.size,
        noAddress: plans.filter((p) => p.outcome === "no_address").length,
        lookupFailed: 0,
        deferred,
      };
      yield* Effect.sync(() => record(result));
      yield* Effect.logInfo("rsvp digest run complete", { ...result });
      return result;
    }).pipe(Effect.withSpan("cire.rsvp_digest.send"));
  },

  /**
   * Turn one person's digest off for one wedding, from a verified stop link.
   * Acts only while they hold a seat that receives the digest — the same
   * `editor` capability the run mails — so a link from before a seat was
   * removed leaves no row behind for someone who is no longer a host.
   */
  stop(
    target: DigestStopTarget,
  ): Effect.Effect<DigestStopOutcome, RsvpDigestError | RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, osnProfileId } = target;
      // One statement: this person's seat on the wedding, if any.
      const [row] = yield* read(() =>
        db
          .select({ seatRole: weddingHosts.role })
          .from(weddingHosts)
          .where(
            and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId)),
          )
          .all(),
      );
      const role: WeddingRole | null = row ? normaliseHostRole(row.seatRole) : null;
      if (role === null || !receivesDigest(role)) return "no_seat";
      yield* rsvpChangeService.setDigest(weddingId, osnProfileId, false);
      return "stopped";
    }).pipe(Effect.withSpan("cire.rsvp_digest.stop"));
  },
};

/** One stop link per recipient, keyed like the plans. Empty without a key. */
function signStopLinks(
  stopLinks: RsvpDigestOptions["stopLinks"],
  recipients: readonly Recipient[],
): Effect.Effect<Map<string, string>> {
  if (!stopLinks || recipients.length === 0) return Effect.succeed(new Map());
  return Effect.tryPromise(async () => {
    const key = await deriveDigestStopKey(stopLinks.secret);
    return Promise.all(
      recipients.map(
        async (r) =>
          [
            noticeKey(r.weddingId, r.osnProfileId),
            await digestStopUrl(stopLinks.apiOrigin, key, r),
          ] as const,
      ),
    );
  }).pipe(
    Effect.map((pairs) => new Map(pairs)),
    Effect.catch(() =>
      Effect.logWarning("rsvp digest: stop links not signed — sending without them").pipe(
        Effect.as(new Map<string, string>()),
      ),
    ),
  );
}

function record(result: RsvpDigestResult) {
  const pairs: [RsvpDigestOutcome, number][] = [
    ["sent", result.sent],
    ["failed", result.failed],
    ["no_address", result.noAddress],
    ["lookup_failed", result.lookupFailed],
    ["deferred", result.deferred],
  ];
  for (const [outcome, count] of pairs) if (count > 0) metricRsvpDigestEmails(outcome, count);
}
