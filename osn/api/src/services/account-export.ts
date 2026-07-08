/**
 * C-H1 — DSAR Art. 15 (access) / Art. 20 (portability) data export.
 *
 * Produces the `GET /account/export` bundle as a streamed **NDJSON** envelope
 * so the response never materialises the full dataset in memory:
 *
 *   {"version":1,"sections":[...]}          ← header (first line)
 *   {"section":"account","record":{...}}    ← one object per line
 *   {"section":"profiles","record":{...}}
 *   ...
 *   {"degraded":"zap","reason":"..."}        ← emitted if a bridge fails
 *   {"end":true}                             ← terminator (last line)
 *
 * Every multi-row osn section is read with **keyset pagination**
 * (`LIMIT 500 WHERE id > :cursor ORDER BY id`) — no OFFSET — so a large table
 * streams in bounded batches. The `pulse.*` / `zap.*` sections are fetched via
 * ARC (`POST /internal/account-export`, scope `account:export`) and their
 * NDJSON sub-bundles are piped through line-by-line.
 *
 * Privacy invariant (P6 / [[identity-model]]): the internal `accountId` is the
 * multi-account correlation key and MUST NOT appear anywhere in the output —
 * it is used only as the internal join key. See `osn/api/tests/privacy.test.ts`.
 *
 * The wire contract is locked in `[[wiki/compliance/dsar]]`.
 */

import * as schema from "@osn/db/schema";
import type { DbService } from "@osn/db/service";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

const {
  accounts,
  blocks,
  connections,
  emailChanges,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
} = schema;

type OsnDb = DbService["db"];

/** Keyset page size. Matches the locked DSAR contract (`LIMIT 500`). */
const PAGE_SIZE = 500;

/**
 * The sections the bundle can contain, advertised in the header line so a
 * consumer knows the full shape up front. `pulse.*` / `zap.*` are attempted
 * via ARC fan-out and may instead surface a `{"degraded":...}` line.
 */
export const EXPORT_SECTIONS = [
  "account",
  "profiles",
  "passkeys",
  "sessions",
  "security_events",
  "recovery_codes",
  "email_changes",
  "connections",
  "blocks",
  "organisations",
  "pulse.rsvps",
  "pulse.events_hosted",
  "pulse.close_friends",
  "zap.chats",
] as const;

/** A downstream service to fan the export out to over ARC. */
export interface ExportDownstream {
  /** Bundle namespace + degraded-line label, e.g. "pulse" | "zap". */
  readonly namespace: string;
  /** Full URL of the downstream's `/internal/account-export` endpoint. */
  readonly url: string;
  /** ARC audience of the downstream, e.g. "pulse-api" | "zap-api". */
  readonly audience: string;
}

const DEFAULT_PULSE_API_URL = "http://localhost:3001";
const DEFAULT_ZAP_API_URL = "http://localhost:3002";

/** The default fan-out targets (Pulse + Zap), resolved from env. */
export function defaultExportDownstreams(env?: {
  pulseApiUrl?: string;
  zapApiUrl?: string;
}): ExportDownstream[] {
  const pulse = env?.pulseApiUrl ?? process.env.PULSE_API_URL ?? DEFAULT_PULSE_API_URL;
  const zap = env?.zapApiUrl ?? process.env.ZAP_API_URL ?? DEFAULT_ZAP_API_URL;
  return [
    { namespace: "pulse", url: `${pulse}/internal/account-export`, audience: "pulse-api" },
    { namespace: "zap", url: `${zap}/internal/account-export`, audience: "zap-api" },
  ];
}

const jsonLine = (o: unknown): string => `${JSON.stringify(o)}\n`;

/**
 * Drives one keyset-paginated section: repeatedly fetches pages of at most
 * {@link PAGE_SIZE} rows whose cursor column is strictly greater than the last
 * seen, yielding each row. `fetchPage` must return rows ordered ascending by
 * their `_cursor`.
 */
async function* keyset<R extends { _cursor: string }>(
  fetchPage: (cursor: string) => Promise<R[]>,
): AsyncGenerator<R> {
  let cursor = "";
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential (cursor depends on the prior page)
    const rows = await fetchPage(cursor);
    for (const row of rows) yield row;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!._cursor;
  }
}

/**
 * Streams a downstream service's NDJSON sub-bundle line-by-line into the outer
 * envelope. On any failure (unreachable, non-2xx, mid-stream error) yields a
 * single `{"degraded":<namespace>,...}` record instead so the user gets a
 * partial bundle with a visible gap rather than a truncated stream.
 */
async function* fanOutSection(
  ds: ExportDownstream,
  accountId: string,
  profileIds: string[],
  fetchStream: (ds: ExportDownstream, body: unknown) => Promise<Response>,
): AsyncGenerator<string> {
  try {
    const res = await fetchStream(ds, { account_id: accountId, profile_ids: profileIds });
    // Defence-in-depth: the default `fetchStream` (`arcFetchStream`) already
    // throws on a non-2xx status, but this guard keeps `fanOutSection` honest
    // for any injected fetcher — a downstream error body must degrade, never
    // be piped into the user's bundle as if it were real records.
    if (!res.ok) {
      yield jsonLine({ degraded: ds.namespace, reason: `http_${res.status}` });
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      yield jsonLine({ degraded: ds.namespace, reason: "no_response_body" });
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- streaming read loop
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (l.trim()) yield `${l}\n`;
      }
    }
    const tail = buf.trim();
    if (tail) yield `${tail}\n`;
  } catch (e) {
    yield jsonLine({
      degraded: ds.namespace,
      reason: e instanceof Error ? e.message : "fan_out_failed",
    });
  }
}

/**
 * Async generator of NDJSON lines for the full export bundle. The route wraps
 * this in a {@link ReadableStream} via {@link ndjsonStream}.
 */
export async function* exportLines(opts: {
  db: OsnDb;
  accountId: string;
  downstreams: ExportDownstream[];
  /** Injected so tests can stub the fan-out without a live downstream. */
  fetchStream: (ds: ExportDownstream, body: unknown) => Promise<Response>;
}): AsyncGenerator<string> {
  const { db, accountId, downstreams, fetchStream } = opts;

  yield jsonLine({ version: 1, sections: [...EXPORT_SECTIONS] });

  // account — singleton. Explicit field list; NEVER the internal accountId.
  const acct = await db
    .select({
      email: accounts.email,
      passkeyUserId: accounts.passkeyUserId,
      maxProfiles: accounts.maxProfiles,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (acct[0]) yield jsonLine({ section: "account", record: acct[0] });

  // profiles — also collects the owned profileIds used to scope graph sections
  // and the downstream fan-out.
  const profileIds: string[] = [];
  for await (const row of keyset(async (cursor) =>
    db
      .select({
        _cursor: users.id,
        id: users.id,
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        isDefault: users.isDefault,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(and(eq(users.accountId, accountId), gt(users.id, cursor)))
      .orderBy(asc(users.id))
      .limit(PAGE_SIZE),
  )) {
    const { _cursor, ...record } = row;
    void _cursor;
    profileIds.push(record.id);
    yield jsonLine({ section: "profiles", record });
  }

  // passkeys — metadata only (never credentialId / publicKey).
  for await (const row of keyset(async (cursor) =>
    db
      .select({
        _cursor: passkeys.id,
        id: passkeys.id,
        label: passkeys.label,
        aaguid: passkeys.aaguid,
        backupEligible: passkeys.backupEligible,
        backupState: passkeys.backupState,
        lastUsedAt: passkeys.lastUsedAt,
        createdAt: passkeys.createdAt,
      })
      .from(passkeys)
      .where(and(eq(passkeys.accountId, accountId), gt(passkeys.id, cursor)))
      .orderBy(asc(passkeys.id))
      .limit(PAGE_SIZE),
  )) {
    const { _cursor, ...record } = row;
    void _cursor;
    yield jsonLine({ section: "passkeys", record });
  }

  // sessions — coarse device metadata; ip_hash is HMAC-peppered (irreversible).
  for await (const row of keyset(async (cursor) =>
    db
      .select({
        _cursor: sessions.id,
        uaLabel: sessions.uaLabel,
        ipHash: sessions.ipHash,
        lastUsedAt: sessions.lastUsedAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), gt(sessions.id, cursor)))
      .orderBy(asc(sessions.id))
      .limit(PAGE_SIZE),
  )) {
    const { _cursor, ...record } = row;
    void _cursor;
    yield jsonLine({ section: "sessions", record });
  }

  // security_events
  for await (const row of keyset(async (cursor) =>
    db
      .select({
        _cursor: securityEvents.id,
        kind: securityEvents.kind,
        createdAt: securityEvents.createdAt,
        acknowledgedAt: securityEvents.acknowledgedAt,
      })
      .from(securityEvents)
      .where(and(eq(securityEvents.accountId, accountId), gt(securityEvents.id, cursor)))
      .orderBy(asc(securityEvents.id))
      .limit(PAGE_SIZE),
  )) {
    const { _cursor, ...record } = row;
    void _cursor;
    yield jsonLine({ section: "security_events", record });
  }

  // recovery_codes — counts only (never the hashes). Bounded set (≤10 rows).
  const codes = await db
    .select({ usedAt: recoveryCodes.usedAt })
    .from(recoveryCodes)
    .where(eq(recoveryCodes.accountId, accountId));
  yield jsonLine({
    section: "recovery_codes",
    record: { total: codes.length, used: codes.filter((c) => c.usedAt !== null).length },
  });

  // email_changes
  for await (const row of keyset(async (cursor) =>
    db
      .select({
        _cursor: emailChanges.id,
        previousEmail: emailChanges.previousEmail,
        newEmail: emailChanges.newEmail,
        completedAt: emailChanges.completedAt,
      })
      .from(emailChanges)
      .where(and(eq(emailChanges.accountId, accountId), gt(emailChanges.id, cursor)))
      .orderBy(asc(emailChanges.id))
      .limit(PAGE_SIZE),
  )) {
    const { _cursor, ...record } = row;
    void _cursor;
    yield jsonLine({ section: "email_changes", record });
  }

  // connections — both directions, resolved to the peers' handles (not ids).
  if (profileIds.length > 0) {
    const reqU = alias(users, "req_u");
    const addU = alias(users, "add_u");
    for await (const row of keyset(async (cursor) =>
      db
        .select({
          _cursor: connections.id,
          requesterHandle: reqU.handle,
          addresseeHandle: addU.handle,
          status: connections.status,
          createdAt: connections.createdAt,
          updatedAt: connections.updatedAt,
        })
        .from(connections)
        .innerJoin(reqU, eq(reqU.id, connections.requesterId))
        .innerJoin(addU, eq(addU.id, connections.addresseeId))
        .where(
          and(
            or(
              inArray(connections.requesterId, profileIds),
              inArray(connections.addresseeId, profileIds),
            ),
            gt(connections.id, cursor),
          ),
        )
        .orderBy(asc(connections.id))
        .limit(PAGE_SIZE),
    )) {
      const { _cursor, ...record } = row;
      void _cursor;
      yield jsonLine({ section: "connections", record });
    }

    // blocks — only those this account's profiles created.
    for await (const row of keyset(async (cursor) =>
      db
        .select({
          _cursor: blocks.id,
          blockedHandle: users.handle,
          createdAt: blocks.createdAt,
        })
        .from(blocks)
        .innerJoin(users, eq(users.id, blocks.blockedId))
        .where(and(inArray(blocks.blockerId, profileIds), gt(blocks.id, cursor)))
        .orderBy(asc(blocks.id))
        .limit(PAGE_SIZE),
    )) {
      const { _cursor, ...record } = row;
      void _cursor;
      yield jsonLine({ section: "blocks", record });
    }

    // organisations — owned (role "owner") …
    for await (const row of keyset(async (cursor) =>
      db
        .select({
          _cursor: organisations.id,
          handle: organisations.handle,
          name: organisations.name,
          createdAt: organisations.createdAt,
        })
        .from(organisations)
        .where(and(inArray(organisations.ownerId, profileIds), gt(organisations.id, cursor)))
        .orderBy(asc(organisations.id))
        .limit(PAGE_SIZE),
    )) {
      const { _cursor, ...rest } = row;
      void _cursor;
      yield jsonLine({ section: "organisations", record: { ...rest, role: "owner" } });
    }

    // … and memberships (role from the membership row).
    for await (const row of keyset(async (cursor) =>
      db
        .select({
          _cursor: organisationMembers.id,
          handle: organisations.handle,
          name: organisations.name,
          role: organisationMembers.role,
        })
        .from(organisationMembers)
        .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
        .where(
          and(
            inArray(organisationMembers.profileId, profileIds),
            gt(organisationMembers.id, cursor),
          ),
        )
        .orderBy(asc(organisationMembers.id))
        .limit(PAGE_SIZE),
    )) {
      const { _cursor, ...record } = row;
      void _cursor;
      yield jsonLine({ section: "organisations", record });
    }
  }

  // pulse.* / zap.* — ARC fan-out, streamed sub-bundles, degraded-tolerant.
  for (const ds of downstreams) {
    yield* fanOutSection(ds, accountId, profileIds, fetchStream);
  }

  yield jsonLine({ end: true });
}

/** Wraps an NDJSON line generator as a byte {@link ReadableStream}. */
export function ndjsonStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await gen.return?.(undefined);
    },
  });
}
