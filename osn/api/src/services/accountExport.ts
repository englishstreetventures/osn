/**
 * DSAR account-export orchestrator (C-H1, GDPR Art. 15 + Art. 20, CCPA
 * right-to-know).
 *
 * Streams the account holder's complete data bundle as NDJSON. Identity-
 * domain sections (account, profiles, passkeys, sessions, security_events,
 * recovery_codes counts, email_changes, connections, blocks, organisations,
 * dsar_requests) are read from `osn/db` directly. Pulse + Zap sections are
 * fetched via the ARC bridges in `./exportBridges.ts` in parallel.
 *
 * Wire format (locked in `wiki/compliance/dsar.md` §"Wire format"):
 *   • Header: `{"version":1,"sections":[...]}`
 *   • Body: one JSON object per line, `{"section":"<name>","row":{...}}`
 *   • Advisory / tombstone lines: `{"degraded":"<svc>", ...}`,
 *     `{"truncated":"<section>", ...}`, `{"section":"zap.chats_advisory", ...}`
 *   • Trailer: `{"end":true,"completedAt":"<iso8601>"}`
 *
 * Memory budget: ≤32 MB resident per export. Per-section keyset
 * pagination at LIMIT 500 keeps the in-process buffer small; bridge
 * streams use native back-pressure.
 *
 * Privacy invariants (per dsar.md §"Per-right execution / Art. 15"):
 *   • `accounts.accountId` is NEVER included — the column is the multi-
 *     account correlation key. Only the curated field list ships.
 *   • `passkeys.credentialId` and `passkeys.publicKey` are NEVER included —
 *     no user value, transport leak risk.
 *   • `sessions.id` (the SHA-256 of the token) is NEVER included.
 *   • `recovery_codes.code_hash` is NEVER included — only counts.
 *   • `messages.ciphertext` (Zap) is excluded with an explicit advisory line.
 */

import {
  accounts,
  blocks,
  connections,
  dsarRequests,
  emailChanges,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
} from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricDsarExportRow, withDsarExport } from "../metrics";
import { ExportBridgeError, streamPulseExport, streamZapExport } from "./exportBridges";

type Drizzle = DbService["db"];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AccountExportError extends Data.TaggedError("AccountExportError")<{
  readonly cause: unknown;
}> {}

const wrapBridgeError = (cause: ExportBridgeError) => new AccountExportError({ cause });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Page size for every keyset-paginated section. */
const PAGE_SIZE = 500;

/** NDJSON wire-format version. Bumped on a backwards-incompatible change. */
const BUNDLE_VERSION = 1;

/** Total memory budget (post-serialise) before truncation kicks in (32 MB). */
const MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Authoritative section ordering. Matches the header line so consumers
 * can trust both. Pulse + Zap subsections live under their service's
 * dotted prefix.
 */
const SECTIONS = [
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
  "pulse.pulse_users",
  "zap.chats",
  "dsar_requests",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportLine {
  readonly raw: string;
}

const line = (obj: unknown): ExportLine => ({ raw: JSON.stringify(obj) });

// ---------------------------------------------------------------------------
// Direct-DB section streamers
// ---------------------------------------------------------------------------

async function* paginate<R>(
  fetchPage: (cursor: string | null) => Promise<R[]>,
  rowId: (row: R) => string,
  pageSize = PAGE_SIZE,
): AsyncIterable<R> {
  let cursor: string | null = null;
  while (true) {
    const page = await fetchPage(cursor);
    if (page.length === 0) return;
    for (const row of page) yield row;
    if (page.length < pageSize) return;
    cursor = rowId(page[page.length - 1]);
  }
}

const isoOrNull = (v: Date | number | null | undefined): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") {
    // Unix seconds vs ms heuristic: anything < 10^11 is seconds.
    return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  }
  return new Date(v as unknown as number).toISOString();
};

// ---------------------------------------------------------------------------
// Identity sections — single-row + multi-row collectors
// ---------------------------------------------------------------------------

async function* iterAccount(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  const rows = await db
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
  if (rows.length === 0) return;
  const r = rows[0];
  metricDsarExportRow("account", 1);
  yield line({
    section: "account",
    row: {
      // dsar.md line 49: explicit field list — accountId NEVER included.
      email: r.email,
      passkey_user_id: r.passkeyUserId,
      max_profiles: r.maxProfiles,
      created_at: isoOrNull(r.createdAt),
      updated_at: isoOrNull(r.updatedAt),
    },
  });
}

async function* iterProfiles(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: users.id,
          handle: users.handle,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          isDefault: users.isDefault,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(
          cursor
            ? and(eq(users.accountId, accountId), gt(users.id, cursor))
            : eq(users.accountId, accountId),
        )
        .orderBy(asc(users.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "profiles",
      row: {
        id: r.id,
        handle: r.handle,
        display_name: r.displayName,
        avatar_url: r.avatarUrl,
        is_default: r.isDefault,
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    });
  }
  metricDsarExportRow("profiles", total);
}

async function* iterPasskeys(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: passkeys.id,
          // CRITICAL: do not select credentialId or publicKey.
          label: passkeys.label,
          aaguid: passkeys.aaguid,
          backupEligible: passkeys.backupEligible,
          backupState: passkeys.backupState,
          lastUsedAt: passkeys.lastUsedAt,
          createdAt: passkeys.createdAt,
          updatedAt: passkeys.updatedAt,
        })
        .from(passkeys)
        .where(
          cursor
            ? and(eq(passkeys.accountId, accountId), gt(passkeys.id, cursor))
            : eq(passkeys.accountId, accountId),
        )
        .orderBy(asc(passkeys.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "passkeys",
      row: {
        id: r.id,
        label: r.label,
        aaguid: r.aaguid,
        backup_eligible: r.backupEligible,
        backup_state: r.backupState,
        last_used_at: isoOrNull(r.lastUsedAt),
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    });
  }
  metricDsarExportRow("passkeys", total);
}

async function* iterSessions(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          // CRITICAL: sessions.id is the SHA-256 of the token — exclude.
          uaLabel: sessions.uaLabel,
          ipHash: sessions.ipHash,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          expiresAt: sessions.expiresAt,
          familyId: sessions.familyId,
          // We use familyId as the cursor surrogate since `id` isn't exported.
          rowKey: sessions.id,
        })
        .from(sessions)
        .where(
          cursor
            ? and(eq(sessions.accountId, accountId), gt(sessions.id, cursor))
            : eq(sessions.accountId, accountId),
        )
        .orderBy(asc(sessions.id))
        .limit(PAGE_SIZE),
    (r) => r.rowKey,
  )) {
    total++;
    yield line({
      section: "sessions",
      row: {
        ua_label: r.uaLabel,
        ip_hash: r.ipHash,
        family_id: r.familyId,
        created_at: isoOrNull(r.createdAt),
        last_used_at: isoOrNull(r.lastUsedAt),
        expires_at: isoOrNull(r.expiresAt),
      },
    });
  }
  metricDsarExportRow("sessions", total);
}

async function* iterSecurityEvents(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: securityEvents.id,
          kind: securityEvents.kind,
          createdAt: securityEvents.createdAt,
          acknowledgedAt: securityEvents.acknowledgedAt,
          ipHash: securityEvents.ipHash,
          uaLabel: securityEvents.uaLabel,
        })
        .from(securityEvents)
        .where(
          cursor
            ? and(eq(securityEvents.accountId, accountId), gt(securityEvents.id, cursor))
            : eq(securityEvents.accountId, accountId),
        )
        .orderBy(asc(securityEvents.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "security_events",
      row: {
        id: r.id,
        kind: r.kind,
        created_at: isoOrNull(r.createdAt),
        acknowledged_at: isoOrNull(r.acknowledgedAt),
        ip_hash: r.ipHash,
        ua_label: r.uaLabel,
      },
    });
  }
  metricDsarExportRow("security_events", total);
}

async function* iterRecoveryCodes(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  // Counts only — the code hashes never leave the DB.
  const rows = await db
    .select({
      total: recoveryCodes.id,
      usedAt: recoveryCodes.usedAt,
    })
    .from(recoveryCodes)
    .where(eq(recoveryCodes.accountId, accountId));
  let used = 0;
  for (const r of rows) if (r.usedAt != null) used++;
  metricDsarExportRow("recovery_codes", 1);
  yield line({
    section: "recovery_codes",
    row: { total: rows.length, used },
  });
}

async function* iterEmailChanges(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: emailChanges.id,
          previousEmail: emailChanges.previousEmail,
          newEmail: emailChanges.newEmail,
          completedAt: emailChanges.completedAt,
        })
        .from(emailChanges)
        .where(
          cursor
            ? and(eq(emailChanges.accountId, accountId), gt(emailChanges.id, cursor))
            : eq(emailChanges.accountId, accountId),
        )
        .orderBy(asc(emailChanges.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "email_changes",
      row: {
        previous_email: r.previousEmail,
        new_email: r.newEmail,
        completed_at: isoOrNull(r.completedAt),
      },
    });
  }
  metricDsarExportRow("email_changes", total);
}

async function* iterConnections(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<ExportLine> {
  if (profileIds.length === 0) return;
  let total = 0;
  // A connection is exported if EITHER side belongs to the account.
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: connections.id,
          requesterId: connections.requesterId,
          addresseeId: connections.addresseeId,
          status: connections.status,
          createdAt: connections.createdAt,
          updatedAt: connections.updatedAt,
        })
        .from(connections)
        .where(
          cursor
            ? and(inArray(connections.requesterId, [...profileIds]), gt(connections.id, cursor))
            : inArray(connections.requesterId, [...profileIds]),
        )
        .orderBy(asc(connections.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "connections",
      row: {
        id: r.id,
        requester_id: r.requesterId,
        addressee_id: r.addresseeId,
        status: r.status,
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    });
  }
  // Second pass: connections where the account is the addressee. We
  // filter out any already-yielded by requester pass via a Set in memory
  // — the count is bounded by user connection count, well under the 32
  // MB envelope.
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: connections.id,
          requesterId: connections.requesterId,
          addresseeId: connections.addresseeId,
          status: connections.status,
          createdAt: connections.createdAt,
          updatedAt: connections.updatedAt,
        })
        .from(connections)
        .where(
          cursor
            ? and(inArray(connections.addresseeId, [...profileIds]), gt(connections.id, cursor))
            : inArray(connections.addresseeId, [...profileIds]),
        )
        .orderBy(asc(connections.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    // De-dup self-connections (requester ∈ profileIds AND addressee ∈ profileIds)
    if (profileIds.includes(r.requesterId)) continue;
    total++;
    yield line({
      section: "connections",
      row: {
        id: r.id,
        requester_id: r.requesterId,
        addressee_id: r.addresseeId,
        status: r.status,
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    });
  }
  metricDsarExportRow("connections", total);
}

async function* iterBlocks(db: Drizzle, profileIds: readonly string[]): AsyncIterable<ExportLine> {
  if (profileIds.length === 0) return;
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: blocks.id,
          blockerId: blocks.blockerId,
          blockedId: blocks.blockedId,
          createdAt: blocks.createdAt,
        })
        .from(blocks)
        .where(
          cursor
            ? and(inArray(blocks.blockerId, [...profileIds]), gt(blocks.id, cursor))
            : inArray(blocks.blockerId, [...profileIds]),
        )
        .orderBy(asc(blocks.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "blocks",
      row: {
        id: r.id,
        blocker_id: r.blockerId,
        blocked_id: r.blockedId,
        created_at: isoOrNull(r.createdAt),
      },
    });
  }
  metricDsarExportRow("blocks", total);
}

async function* iterOrganisations(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<ExportLine> {
  if (profileIds.length === 0) return;
  let total = 0;
  // Owned orgs.
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: organisations.id,
          handle: organisations.handle,
          name: organisations.name,
          ownerId: organisations.ownerId,
          createdAt: organisations.createdAt,
          updatedAt: organisations.updatedAt,
        })
        .from(organisations)
        .where(
          cursor
            ? and(inArray(organisations.ownerId, [...profileIds]), gt(organisations.id, cursor))
            : inArray(organisations.ownerId, [...profileIds]),
        )
        .orderBy(asc(organisations.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "organisations",
      row: {
        id: r.id,
        handle: r.handle,
        name: r.name,
        owner_id: r.ownerId,
        relationship: "owner",
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    });
  }
  // Member orgs.
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          memberId: organisationMembers.id,
          orgId: organisationMembers.organisationId,
          profileId: organisationMembers.profileId,
          role: organisationMembers.role,
          createdAt: organisationMembers.createdAt,
        })
        .from(organisationMembers)
        .where(
          cursor
            ? and(
                inArray(organisationMembers.profileId, [...profileIds]),
                gt(organisationMembers.id, cursor),
              )
            : inArray(organisationMembers.profileId, [...profileIds]),
        )
        .orderBy(asc(organisationMembers.id))
        .limit(PAGE_SIZE),
    (r) => r.memberId,
  )) {
    total++;
    yield line({
      section: "organisations",
      row: {
        organisation_id: r.orgId,
        profile_id: r.profileId,
        role: r.role,
        relationship: "member",
        joined_at: isoOrNull(r.createdAt),
      },
    });
  }
  metricDsarExportRow("organisations", total);
}

async function* iterDsarRequests(db: Drizzle, accountId: string): AsyncIterable<ExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: dsarRequests.id,
          regime: dsarRequests.regime,
          right: dsarRequests.right,
          openedAt: dsarRequests.openedAt,
          closedAt: dsarRequests.closedAt,
          decision: dsarRequests.decision,
          exemption: dsarRequests.exemption,
        })
        .from(dsarRequests)
        .where(
          cursor
            ? and(eq(dsarRequests.accountId, accountId), gt(dsarRequests.id, cursor))
            : eq(dsarRequests.accountId, accountId),
        )
        .orderBy(asc(dsarRequests.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield line({
      section: "dsar_requests",
      row: {
        id: r.id,
        regime: r.regime,
        right: r.right,
        opened_at: isoOrNull(r.openedAt),
        closed_at: isoOrNull(r.closedAt),
        decision: r.decision,
        exemption: r.exemption,
      },
    });
  }
  metricDsarExportRow("dsar_requests", total);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AccountExportOpts {
  /** Account being exported. */
  readonly accountId: string;
  /**
   * Optional override for the bridge timeout (10 s in production). Used by
   * tests to make degraded-bridge cases deterministic.
   */
  readonly bridgeTimeoutMs?: number;
  /**
   * If true, skip the Pulse and Zap fan-out. Used by unit tests that
   * don't want to spin up downstream services.
   */
  readonly skipBridges?: boolean;
}

export interface AccountExportResult {
  /** Streams NDJSON lines (without trailing `\n`). */
  readonly stream: AsyncIterable<ExportLine>;
  /** Resolves to the bundle decision once the stream has fully drained. */
  readonly decision: () => "fulfilled" | "partial";
}

/**
 * Builds the streaming NDJSON bundle for an account holder. The returned
 * AsyncIterable iterates lazily — the route layer adapts it into a
 * `ReadableStream` that the HTTP response body consumes.
 *
 * Memory budget: the orchestrator tracks bytes as it serialises. If the
 * running total exceeds `MEMORY_BUDGET_BYTES` it emits a `truncated`
 * tombstone and stops the current section; the bundle remains valid
 * NDJSON and the user gets a partial export with an explanation.
 *
 * Failure model: per dsar.md §"Fan-out reliability", a failing Pulse or
 * Zap bridge emits a `degraded` line and the bundle decision becomes
 * `partial` rather than aborting. Identity-section DB errors abort
 * (the entire bundle is invalid without identity sections).
 */
export const streamAccountExport = (
  opts: AccountExportOpts,
): Effect.Effect<AccountExportResult, AccountExportError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Resolve the account's profile IDs up front — needed by the bridges
    // and the connections / blocks / organisations passes. We intentionally
    // only fetch the IDs so the bridge bodies stay tiny.
    const profileRows = yield* Effect.tryPromise({
      try: () => db.select({ id: users.id }).from(users).where(eq(users.accountId, opts.accountId)),
      catch: (cause) => new AccountExportError({ cause }),
    });
    const profileIds = profileRows.map((r) => r.id);

    // Resolve bridge AsyncIterables eagerly so the HTTP requests fire
    // concurrently with the identity-section streaming. Bridges fail soft
    // (degraded tombstone in-band) so this Effect.all should not raise;
    // we map the typing anyway in case `Effect.tryPromise` ever surfaces
    // a hard failure.
    const bridgeStreams = opts.skipBridges
      ? null
      : ((yield* Effect.all([streamPulseExport({ profileIds }), streamZapExport({ profileIds })], {
          concurrency: "unbounded",
        }).pipe(Effect.mapError(wrapBridgeError))) as readonly [
          AsyncIterable<{ raw: string }>,
          AsyncIterable<{ raw: string }>,
        ]);

    let bytesEmitted = 0;
    let degraded = false;

    const yieldLine = (l: ExportLine): ExportLine => {
      bytesEmitted += l.raw.length + 1;
      return l;
    };
    const overBudget = () => bytesEmitted >= MEMORY_BUDGET_BYTES;
    const truncate = (where: string): ExportLine =>
      yieldLine(line({ truncated: where, reason: "memory_budget" }));

    async function* generate(): AsyncIterable<ExportLine> {
      // Header — first line so consumers can sniff version/sections.
      yield yieldLine(line({ version: BUNDLE_VERSION, sections: SECTIONS }));

      const identitySections: Array<{
        name: string;
        run: () => AsyncIterable<ExportLine>;
      }> = [
        { name: "account", run: () => iterAccount(db, opts.accountId) },
        { name: "profiles", run: () => iterProfiles(db, opts.accountId) },
        { name: "passkeys", run: () => iterPasskeys(db, opts.accountId) },
        { name: "sessions", run: () => iterSessions(db, opts.accountId) },
        { name: "security_events", run: () => iterSecurityEvents(db, opts.accountId) },
        { name: "recovery_codes", run: () => iterRecoveryCodes(db, opts.accountId) },
        { name: "email_changes", run: () => iterEmailChanges(db, opts.accountId) },
        { name: "connections", run: () => iterConnections(db, profileIds) },
        { name: "blocks", run: () => iterBlocks(db, profileIds) },
        { name: "organisations", run: () => iterOrganisations(db, profileIds) },
      ];

      let truncated = false;
      for (const { name, run } of identitySections) {
        if (overBudget()) {
          yield truncate(name);
          truncated = true;
          break;
        }
        for await (const l of run()) {
          yield yieldLine(l);
          if (overBudget()) {
            yield truncate(name);
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }

      if (!truncated && bridgeStreams) {
        for await (const bl of bridgeStreams[0]) {
          if (bl.raw.includes('"degraded"')) degraded = true;
          if (bl.raw.includes('"end":true')) continue;
          if (bl.raw.includes('"source":"pulse-api"')) continue;
          yield yieldLine({ raw: bl.raw });
          if (overBudget()) {
            yield truncate("pulse");
            truncated = true;
            break;
          }
        }
      }
      if (!truncated && bridgeStreams) {
        for await (const bl of bridgeStreams[1]) {
          if (bl.raw.includes('"degraded"')) degraded = true;
          if (bl.raw.includes('"end":true')) continue;
          if (bl.raw.includes('"source":"zap-api"')) continue;
          yield yieldLine({ raw: bl.raw });
          if (overBudget()) {
            yield truncate("zap");
            truncated = true;
            break;
          }
        }
      }

      if (!truncated) {
        for await (const l of iterDsarRequests(db, opts.accountId)) {
          yield yieldLine(l);
          if (overBudget()) {
            yield truncate("dsar_requests");
            truncated = true;
            break;
          }
        }
      }

      // Trailer — always emitted, even on truncation so the consumer can
      // tell the bundle ended cleanly vs the connection dropped.
      yield line({ end: true, completedAt: new Date().toISOString() });
    }

    return {
      stream: generate(),
      decision: () => (degraded ? "partial" : "fulfilled"),
    } satisfies AccountExportResult;
  }).pipe(withDsarExport("stream"));

// ---------------------------------------------------------------------------
// dsar_requests audit row helpers
// ---------------------------------------------------------------------------

const genDsarId = (): string => "dsar_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * Inserts a fresh dsar_requests row at the start of an export request and
 * returns its id. The closing call (`closeDsarRequest`) updates the same
 * row with `closedAt` + `decision` once the stream drains.
 */
export const openDsarRequest = (
  accountId: string,
  right: "access" | "portability" = "access",
): Effect.Effect<{ id: string }, AccountExportError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = genDsarId();
    const openedAt = Math.floor(Date.now() / 1000);
    yield* Effect.tryPromise({
      try: () =>
        db.insert(dsarRequests).values({
          id,
          accountId,
          regime: "both",
          right,
          openedAt,
          closedAt: null,
          decision: null,
          exemption: null,
          evidencePath: null,
        }),
      catch: (cause) => new AccountExportError({ cause }),
    });
    return { id };
  }).pipe(withDsarExport("begin"));

export const closeDsarRequest = (
  id: string,
  decision: "fulfilled" | "partial" | "refused",
  exemption: string | null = null,
): Effect.Effect<void, AccountExportError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const closedAt = Math.floor(Date.now() / 1000);
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(dsarRequests)
          .set({ closedAt, decision, exemption })
          .where(eq(dsarRequests.id, id)),
      catch: (cause) => new AccountExportError({ cause }),
    });
  }).pipe(withDsarExport("complete"));

/**
 * Returns the most recent fulfilled-or-partial export timestamp for the
 * account, plus when the next export becomes available given the daily
 * limiter. Used by `GET /account/export/status` so the UI can render a
 * countdown without burning the daily budget.
 */
export const getExportStatus = (
  accountId: string,
  windowMs = 86_400_000,
): Effect.Effect<
  { lastExportAt: string | null; nextAvailableAt: string | null },
  AccountExportError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ openedAt: dsarRequests.openedAt })
          .from(dsarRequests)
          .where(eq(dsarRequests.accountId, accountId))
          .orderBy(asc(dsarRequests.openedAt))
          .limit(50),
      catch: (cause) => new AccountExportError({ cause }),
    });
    if (rows.length === 0) {
      return { lastExportAt: null, nextAvailableAt: null };
    }
    const last = rows[rows.length - 1].openedAt;
    const lastIso = isoOrNull(last);
    const nextMs = last * 1000 + windowMs;
    const nextIso = nextMs > Date.now() ? new Date(nextMs).toISOString() : null;
    return { lastExportAt: lastIso, nextAvailableAt: nextIso };
  });
