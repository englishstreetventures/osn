import { chatMembers, chats } from "@zap/db/schema";
import { Db, type DbService } from "@zap/db/service";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricZapDsarExportRow } from "../metrics";

/**
 * Account-data export contributions from Zap, served via the
 * shared-secret-protected `/account-export/internal` endpoint.
 *
 * Zap's contribution is intentionally narrow: chat membership + role +
 * joined-at, no message content. The server holds only ciphertext +
 * nonce — under E2E encryption (Signal Protocol) Zap cannot decrypt the
 * messages, so including them in the export adds zero user value (the
 * holder can't read them either) and risks future re-encryption migration
 * debt. The bundle includes an explicit advisory line so the user sees
 * the gap is intentional rather than a leak.
 *
 * Caller passes the OSN profile IDs that belong to the account; Zap
 * never re-derives this mapping.
 */

export class ZapExportError extends Data.TaggedError("ZapExportError")<{
  readonly cause: unknown;
}> {}

/** Page size for every section. Matches dsar.md §"Wire format" (LIMIT 500). */
export const PAGE_SIZE = 500;

/** Hard cap on profile IDs in a single export request. Bounds the IN(...) clause. */
export const MAX_EXPORT_PROFILE_IDS = 50;

export type ZapExportSectionName = "zap.chats" | "zap.chats_advisory";

export interface ZapExportLine {
  readonly section: ZapExportSectionName;
  readonly row: Record<string, unknown>;
}

const isoOrNull = (v: Date | number | null | undefined): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v as unknown as number).toISOString();
};

type Drizzle = DbService["db"];

async function* paginate<R>(
  fetchPage: (cursor: string | null) => Promise<R[]>,
  rowId: (row: R) => string,
): AsyncIterable<R> {
  let cursor: string | null = null;
  while (true) {
    const page = await fetchPage(cursor);
    if (page.length === 0) return;
    for (const row of page) yield row;
    if (page.length < PAGE_SIZE) return;
    cursor = rowId(page[page.length - 1]);
  }
}

async function* iterChats(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<ZapExportLine> {
  let total = 0;
  // Join chat_members → chats so the row carries the chat type + title +
  // event linkage. The cursor walks chat_members.id (stable, indexed).
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          memberId: chatMembers.id,
          chatId: chatMembers.chatId,
          profileId: chatMembers.profileId,
          role: chatMembers.role,
          joinedAt: chatMembers.joinedAt,
          chatType: chats.type,
          chatTitle: chats.title,
          chatEventId: chats.eventId,
        })
        .from(chatMembers)
        .innerJoin(chats, eq(chats.id, chatMembers.chatId))
        .where(
          cursor
            ? and(inArray(chatMembers.profileId, [...profileIds]), gt(chatMembers.id, cursor))
            : inArray(chatMembers.profileId, [...profileIds]),
        )
        .orderBy(asc(chatMembers.id))
        .limit(PAGE_SIZE),
    (r) => r.memberId,
  )) {
    total++;
    yield {
      section: "zap.chats",
      row: {
        member_id: r.memberId,
        chat_id: r.chatId,
        profile_id: r.profileId,
        role: r.role,
        joined_at: isoOrNull(r.joinedAt),
        chat_type: r.chatType,
        chat_title: r.chatTitle,
        chat_event_id: r.chatEventId,
      },
    };
  }
  metricZapDsarExportRow("chats", total);
}

/**
 * Resolves a bare Drizzle handle from the Effect `Db` service. See
 * pulse/api/src/services/accountExport.ts for the rationale.
 */
export const resolveDbHandle = (): Effect.Effect<Drizzle, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return db;
  });

/**
 * Streams Zap-owned sections for the given profile IDs. The yielded
 * advisory line documents the deliberate exclusion of `messages.ciphertext`
 * so the bundle is self-describing.
 */
export async function* streamAccountExport(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<ZapExportLine> {
  // Self-documenting advisory: tells the consumer why they will not see
  // any decrypted message content. Always emitted, even when the account
  // has no chats — the absence is itself information.
  yield {
    section: "zap.chats_advisory",
    row: {
      excluded: "messages.ciphertext",
      reason: "e2e_encrypted",
      explanation:
        "Zap messages are end-to-end encrypted; the server has no key. The user's local client can export decrypted history separately.",
    },
  };
  if (profileIds.length === 0) return;
  yield* iterChats(db, profileIds);
}
