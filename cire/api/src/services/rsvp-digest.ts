/**
 * The daily RSVP change digest: one email per organiser per wedding, on a day
 * guests changed their RSVPs, and only then.
 *
 * Who gets one: the wedding's owner and every co-host whose role carries the
 * `editor` capability (`policyFor` in `middleware/wedding-role.ts`), less
 * anyone who turned it off for that wedding. What it covers: the changes in
 * `rsvp_changes` past that person's `digest_seq`, counted in households per
 * kind. It carries no guest name (see the template in `@shared/email`).
 *
 * Built for one shared cron invocation on Workers Free — 50 external
 * subrequests, 50 D1 queries and 10 ms of CPU for every sweep at once:
 *
 *  - six D1 queries whatever the number of recipients (the candidates, three
 *    reads naming them, the changes, one upsert for every marker);
 *  - at most {@link RSVP_DIGEST_MAX_EMAILS_PER_RUN} sends and one osn-api
 *    lookup; recipients past the cap are counted `deferred` and go first next
 *    run, because the oldest markers are served first;
 *  - a recipient's marker moves only when they were mailed or osn-api said it
 *    has no address for them. A failed send is retried next run with whatever
 *    has changed since. Nothing older than {@link RSVP_DIGEST_LOOKBACK_MS} is
 *    ever mailed.
 */

import {
  hostRsvpNotices,
  rsvpChanges,
  weddingHosts,
  weddings,
  type RsvpChangeKind,
} from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import type { RsvpDigestChangeKind } from "@shared/email/templates";
import { and, getTableColumns, gt, gte, inArray, max, sql, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { metricRsvpDigestEmails, type RsvpDigestOutcome } from "../metrics";
import { decideCapability, type WeddingRole } from "../middleware/wedding-role";
import { normaliseHostRole } from "./hosts";
import type { OsnOrganiserEmailResolver } from "./osn-bridge";

/**
 * Sends per run. Each is one external subrequest, shared with every other sweep
 * in the invocation, and the chosen recipients must fit one osn-api lookup call
 * (100 ids) so that an empty answer can only mean osn-api did not answer.
 */
export const RSVP_DIGEST_MAX_EMAILS_PER_RUN = 20;

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
  lookup: OsnOrganiserEmailResolver;
  now?: Date;
  maxEmails?: number;
}

interface Recipient {
  weddingId: string;
  osnProfileId: string;
  cursor: number;
}

interface Mark {
  weddingId: string;
  osnProfileId: string;
  seq: number;
}

/** One recipient's result: `outcome` null when there was nothing left to send. */
interface SendOutcome {
  outcome: Exclude<RsvpDigestOutcome, "lookup_failed" | "deferred"> | null;
  mark: Mark | null;
}

interface ChangeGroup {
  weddingId: string;
  familyId: string;
  kind: RsvpChangeKind;
  maxSeq: number;
}

const EMPTY: RsvpDigestResult = { sent: 0, failed: 0, noAddress: 0, lookupFailed: 0, deferred: 0 };

const noticeKey = (weddingId: string, osnProfileId: string) => `${weddingId}::${osnProfileId}`;

const read = <A>(run: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (e) => new RsvpDigestError({ reason: String(e) }),
  });

/** May this role receive the digest? The policy table's `editor` capability. */
const receivesDigest = (role: WeddingRole) => decideCapability(role, "editor").allowed;

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
 * one JSON parameter, and `WHERE true` is what lets SQLite read the `ON` that
 * follows as the upsert rather than a join. A new row takes the defaults a
 * missing row reads as (nothing seen, digest on); an existing row keeps its
 * switch, so a recipient who turned the digest off mid-run stays off.
 */
function buildMarkStatement(db: Db, marks: readonly Mark[], now: Date) {
  const updatedAt = hostRsvpNotices.updatedAt.mapToDriverValue(now);
  const payload = JSON.stringify(marks.map((m) => [m.weddingId, m.osnProfileId, m.seq]));
  const columns = {
    weddingId: sql`json_extract(value, '$[0]')`,
    osnProfileId: sql`json_extract(value, '$[1]')`,
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
  return db
    .insert(hostRsvpNotices)
    .select(sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload}) WHERE true`)
    .onConflictDoUpdate({
      target: [hostRsvpNotices.weddingId, hostRsvpNotices.osnProfileId],
      set: {
        digestSeq: sql`max(${hostRsvpNotices.digestSeq}, excluded.digest_seq)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
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
      const since = new Date(now.getTime() - RSVP_DIGEST_LOOKBACK_MS);

      // 1. Weddings with a change in the window, and each one's newest seq.
      const candidates = yield* read(() =>
        db
          .select({ weddingId: rsvpChanges.weddingId, maxSeq: max(rsvpChanges.seq) })
          .from(rsvpChanges)
          .where(gte(rsvpChanges.createdAt, since))
          .groupBy(rsvpChanges.weddingId)
          .all(),
      );
      if (candidates.length === 0) return EMPTY;
      const newest = new Map(candidates.map((c) => [c.weddingId, c.maxSeq ?? 0]));
      const weddingIds = [...newest.keys()];

      // 2. Who might be mailed for them, and where each one's marker stands.
      const [weddingRows, hostRows, noticeRows] = yield* Effect.all(
        [
          read(() =>
            db
              .select({
                id: weddings.id,
                name: weddings.displayName,
                owner: weddings.ownerOsnProfileId,
              })
              .from(weddings)
              .where(inArray(weddings.id, jsonEachIn(weddingIds)))
              .all(),
          ),
          read(() =>
            db
              .select({
                weddingId: weddingHosts.weddingId,
                osnProfileId: weddingHosts.osnProfileId,
                role: weddingHosts.role,
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
      const people = [
        ...weddingRows.map((w) => ({
          weddingId: w.id,
          osnProfileId: w.owner,
          role: "owner" as WeddingRole,
        })),
        ...hostRows.map((h) => ({
          weddingId: h.weddingId,
          osnProfileId: h.osnProfileId,
          role: normaliseHostRole(h.role) as WeddingRole,
        })),
      ];
      const pending: Recipient[] = [];
      for (const person of people) {
        if (!receivesDigest(person.role)) continue;
        const notice = notices.get(noticeKey(person.weddingId, person.osnProfileId));
        if (notice?.digestEnabled === false) continue;
        const cursor = notice?.digestSeq ?? 0;
        if (cursor >= (newest.get(person.weddingId) ?? 0)) continue;
        pending.push({ weddingId: person.weddingId, osnProfileId: person.osnProfileId, cursor });
      }
      pending.sort(
        (a, b) =>
          a.cursor - b.cursor ||
          a.weddingId.localeCompare(b.weddingId) ||
          a.osnProfileId.localeCompare(b.osnProfileId),
      );
      const chosen = pending.slice(0, maxEmails);
      const deferred = pending.length - chosen.length;
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
          })
          .from(rsvpChanges)
          .where(
            and(
              inArray(rsvpChanges.weddingId, jsonEachIn(chosenWeddings)),
              gte(rsvpChanges.createdAt, since),
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
      }));

      // 4. One lookup. The chosen fit one osn-api call, so an empty answer to a
      // non-empty question means osn-api did not answer: mail nobody, move no
      // marker, and let the next run try again.
      const addresses = yield* Effect.tryPromise(() =>
        options.lookup([...new Set(chosen.map((r) => r.osnProfileId))]),
      ).pipe(Effect.orElseSucceed(() => new Map<string, string>()));
      if (addresses.size === 0) {
        const result = { ...EMPTY, lookupFailed: chosen.length, deferred };
        yield* Effect.sync(() => record(result));
        yield* Effect.logWarning("rsvp digest: osn-api returned no addresses — nothing sent", {
          recipients: chosen.length,
        });
        return result;
      }

      // 5. Send, at most four at a time. A marker moves on a send or a
      // definite "no address", never on a failure.
      const origin = options.organiserOrigin.replace(/\/+$/, "");
      const outcomes = yield* Effect.forEach(
        chosen,
        (recipient): Effect.Effect<SendOutcome> => {
          const mine = groups.filter(
            (g) => g.weddingId === recipient.weddingId && g.maxSeq > recipient.cursor,
          );
          const markSeq =
            mine.length > 0
              ? Math.max(...mine.map((g) => g.maxSeq))
              : (newest.get(recipient.weddingId) ?? 0);
          const mark: Mark = {
            weddingId: recipient.weddingId,
            osnProfileId: recipient.osnProfileId,
            seq: markSeq,
          };
          const to = addresses.get(recipient.osnProfileId);
          if (mine.length === 0) return Effect.succeed({ outcome: null, mark });
          if (!to) return Effect.succeed({ outcome: "no_address", mark });
          const { households, counts } = countGroups(mine);
          return emailService
            .send({
              template: "rsvp-change-digest",
              to,
              data: {
                weddingName: names.get(recipient.weddingId) ?? "",
                households,
                counts,
                rsvpUrl: `${origin}/#/w/${encodeURIComponent(recipient.weddingId)}/guests/rsvps`,
              },
            })
            .pipe(
              Effect.as<SendOutcome>({ outcome: "sent", mark }),
              Effect.catchCause(() =>
                Effect.logWarning("rsvp digest: send failed — retried next run").pipe(
                  Effect.annotateLogs({
                    template: "rsvp-change-digest",
                    weddingId: recipient.weddingId,
                  }),
                  Effect.as<SendOutcome>({ outcome: "failed", mark: null }),
                ),
              ),
            );
        },
        { concurrency: 4 },
      );

      const marks = outcomes.flatMap((o) => (o.mark ? [o.mark] : []));
      if (marks.length > 0) yield* read(() => buildMarkStatement(db, marks, now).run());

      const tally = (outcome: RsvpDigestOutcome) =>
        outcomes.filter((o) => o.outcome === outcome).length;
      const result: RsvpDigestResult = {
        sent: tally("sent"),
        failed: tally("failed"),
        noAddress: tally("no_address"),
        lookupFailed: 0,
        deferred,
      };
      yield* Effect.sync(() => record(result));
      yield* Effect.logInfo("rsvp digest run complete", { ...result });
      return result;
    }).pipe(Effect.withSpan("cire.rsvp_digest.send"));
  },
};

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
