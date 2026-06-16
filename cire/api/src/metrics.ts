/**
 * Cire API domain metrics.
 *
 * Single source of truth — every counter/histogram for cire lives here.
 * Services + routes import the recording helpers (`metric*` / `measure*`) and
 * call them at the relevant points; raw OTel instruments are never used.
 *
 * Namespace `cire`. Names follow `{namespace}.{domain}.{subject}.{measurement}`
 * and every attribute value is a bounded string-literal union, so cardinality
 * is enforced at compile time — no `weddingId` / `guestId` / `familyId` /
 * `publicId` / `osnAccountId` ever reaches a metric attribute (those belong in
 * spans + logs only). See `CLAUDE.md` "Observability" for the full rules.
 *
 * Export caveat (workerd): cire/api runs on Cloudflare Workers, which has no
 * long-lived process to flush a `PeriodicExportingMetricReader`. Until a
 * workerd metric reader is attached (otel-cf-workers / Analytics Engine — see
 * `wiki/todo/deferred.md`), the `.inc()` / `.record()` calls resolve to a
 * no-op meter and cost ~nothing. Defining them now pins the naming +
 * cardinality contract and makes the call-sites permanent.
 */

import {
  BYTE_BUCKETS,
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";
import type { Result } from "@shared/observability/metrics";
import { Effect } from "effect";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const CIRE_METRICS = {
  // Guest claim (pre-auth credential exchange surface).
  claimAttempts: "cire.claim.attempts",
  claimLookupDuration: "cire.claim.lookup.duration",
  // Guest sessions.
  sessionCreated: "cire.session.created",
  // RSVP.
  rsvpUpserted: "cire.rsvp.upserted",
  rsvpBatchSize: "cire.rsvp.batch.size",
  // Organiser spreadsheet import.
  importApplied: "cire.import.applied",
  importRows: "cire.import.rows",
  importReverted: "cire.import.reverted",
  importParseRejected: "cire.import.parse.rejected",
  // Invite builder.
  inviteSaved: "cire.invite.saved",
  inviteAssetUploaded: "cire.invite.asset.uploaded",
  inviteAssetSize: "cire.invite.asset.size",
  // Guest account-linking (OSN bridge).
  accountLinkRequests: "cire.account_link.requests",
  accountLinkUnlinks: "cire.account_link.unlinks",
  accountLinkResolveDuration: "cire.account_link.resolve.duration",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes — bounded string-literal unions ONLY.
// ---------------------------------------------------------------------------

/** Outcome of a guest claim attempt. `rate_limited` is gated upstream by the
 *  per-IP limiter (429 before the handler) and reserved for that call-site. */
export type ClaimResult = "ok" | "invalid_credentials" | "rate_limited" | "error";

/** Terminal RSVP status after an upsert — matches the cire `rsvps.status` enum. */
export type RsvpStatus = "attending" | "declined" | "maybe";

/** Which entity class a row-count histogram sample belongs to. */
export type ImportEntity = "events" | "families" | "guests";

/** Bucketed spreadsheet parse-rejection reason. Free-text `reason` strings on
 *  `MalformedSpreadsheet` collapse to `"malformed"`; unknown tags to `"other"`. */
export type ParseRejectReason =
  | "malformed"
  | "formula_injection"
  | "missing_column"
  | "unmatched_event_column"
  | "other";

/** Outcome of an account-link POST. Mirrors the route's response branches. */
export type AccountLinkResult =
  | "ok"
  | "profile_not_found"
  | "osn_unavailable"
  | "already_linked"
  | "disabled"
  | "error";

/** Outcome of the S2S osn-api profile→account resolve. */
export type ResolveResult = "ok" | "not_found" | "error";

type ClaimAttemptsAttrs = { result: ClaimResult };
type ClaimLookupDurationAttrs = { result: "ok" | "error" };
type SessionCreatedAttrs = { result: "ok" | "error" };
type RsvpUpsertedAttrs = { status: RsvpStatus; result: "ok" | "error" };
type ImportSimpleAttrs = { result: "ok" | "error" };
type ImportRowsAttrs = { entity: ImportEntity };
type ImportParseRejectedAttrs = { reason: ParseRejectReason };
type InviteSimpleAttrs = { result: "ok" | "error" };
type AccountLinkRequestsAttrs = { result: AccountLinkResult };
type AccountLinkUnlinksAttrs = { result: "ok" | "error" };
type AccountLinkResolveDurationAttrs = { result: ResolveResult };

// ---------------------------------------------------------------------------
// Instruments.
// ---------------------------------------------------------------------------

const claimAttempts = createCounter<ClaimAttemptsAttrs>({
  name: CIRE_METRICS.claimAttempts,
  description:
    "Guest claim-code attempts, by outcome — a spike of invalid_credentials is a probing signal",
  unit: "{attempt}",
});

const claimLookupDuration = createHistogram<ClaimLookupDurationAttrs>({
  name: CIRE_METRICS.claimLookupDuration,
  description: "claimService.lookup latency (family + guests + events + rsvps reads)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const sessionCreated = createCounter<SessionCreatedAttrs>({
  name: CIRE_METRICS.sessionCreated,
  description: "Guest session-cookie creations, by outcome",
  unit: "{session}",
});

const rsvpUpserted = createCounter<RsvpUpsertedAttrs>({
  name: CIRE_METRICS.rsvpUpserted,
  description: "RSVP upserts (one per (guest,event) pair), by terminal status",
  unit: "{rsvp}",
});

const rsvpBatchSize = createHistogram<Record<never, never>>({
  name: CIRE_METRICS.rsvpBatchSize,
  description: "Distribution of RSVP batch sizes (pairs submitted per request)",
  unit: "{rsvp}",
  boundaries: [1, 2, 5, 10, 25, 50, 100],
});

const importApplied = createCounter<ImportSimpleAttrs>({
  name: CIRE_METRICS.importApplied,
  description: "Spreadsheet import applies, by outcome",
  unit: "{import}",
});

const importRows = createHistogram<ImportRowsAttrs>({
  name: CIRE_METRICS.importRows,
  description: "Rows created per applied import, by entity class",
  unit: "{row}",
  boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000],
});

const importReverted = createCounter<ImportSimpleAttrs>({
  name: CIRE_METRICS.importReverted,
  description: "Spreadsheet import reverts, by outcome",
  unit: "{revert}",
});

const importParseRejected = createCounter<ImportParseRejectedAttrs>({
  name: CIRE_METRICS.importParseRejected,
  description: "Uploaded CSVs rejected by the parser, by bucketed reason",
  unit: "{rejection}",
});

const inviteSaved = createCounter<InviteSimpleAttrs>({
  name: CIRE_METRICS.inviteSaved,
  description: "Invite text-customisation saves, by outcome",
  unit: "{save}",
});

const inviteAssetUploaded = createCounter<InviteSimpleAttrs>({
  name: CIRE_METRICS.inviteAssetUploaded,
  description: "Invite image uploads, by outcome",
  unit: "{upload}",
});

const inviteAssetSize = createHistogram<Record<never, never>>({
  name: CIRE_METRICS.inviteAssetSize,
  description: "Uploaded invite-image size in bytes (capped at 5 MB by the route)",
  unit: "By",
  boundaries: BYTE_BUCKETS,
});

const accountLinkRequests = createCounter<AccountLinkRequestsAttrs>({
  name: CIRE_METRICS.accountLinkRequests,
  description: "Guest account-link POST attempts, by outcome",
  unit: "{request}",
});

const accountLinkUnlinks = createCounter<AccountLinkUnlinksAttrs>({
  name: CIRE_METRICS.accountLinkUnlinks,
  description: "Guest account-link removals, by outcome",
  unit: "{unlink}",
});

const accountLinkResolveDuration = createHistogram<AccountLinkResolveDurationAttrs>({
  name: CIRE_METRICS.accountLinkResolveDuration,
  description: "S2S osn-api profile→account resolve latency (the ARC call)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

// ---------------------------------------------------------------------------
// Recording helpers — the ONLY way cire code should emit metrics.
// ---------------------------------------------------------------------------

export const metricClaimAttempt = (result: ClaimResult): void => claimAttempts.inc({ result });

export const metricSessionCreated = (result: "ok" | "error"): void =>
  sessionCreated.inc({ result });

export const metricRsvpUpserted = (status: RsvpStatus, result: "ok" | "error"): void =>
  rsvpUpserted.inc({ status, result });

export const metricRsvpBatchSize = (size: number): void => rsvpBatchSize.record(size, {});

export const metricImportApplied = (
  result: "ok" | "error",
  rows?: Record<ImportEntity, number>,
): void => {
  importApplied.inc({ result });
  if (result === "ok" && rows) {
    importRows.record(rows.events, { entity: "events" });
    importRows.record(rows.families, { entity: "families" });
    importRows.record(rows.guests, { entity: "guests" });
  }
};

export const metricImportReverted = (result: "ok" | "error"): void =>
  importReverted.inc({ result });

export const metricImportParseRejected = (reason: ParseRejectReason): void =>
  importParseRejected.inc({ reason });

/** Map a spreadsheet tagged-error `_tag` to the bounded rejection bucket. */
export const bucketParseReason = (tag: string): ParseRejectReason => {
  switch (tag) {
    case "FormulaInjectionDetected":
      return "formula_injection";
    case "MissingRequiredColumn":
      return "missing_column";
    case "UnmatchedEventColumn":
      return "unmatched_event_column";
    case "MalformedSpreadsheet":
      return "malformed";
    default:
      return "other";
  }
};

export const metricInviteSaved = (result: "ok" | "error"): void => inviteSaved.inc({ result });

export const metricInviteAssetUploaded = (result: "ok" | "error", byteLength?: number): void => {
  inviteAssetUploaded.inc({ result });
  if (result === "ok" && byteLength !== undefined) inviteAssetSize.record(byteLength, {});
};

export const metricAccountLinkRequest = (result: AccountLinkResult): void =>
  accountLinkRequests.inc({ result });

export const metricAccountLinkUnlink = (result: "ok" | "error"): void =>
  accountLinkUnlinks.inc({ result });

// ---------------------------------------------------------------------------
// Effect combinators for timed operations (mirrors pulse `measureSeconds`).
// ---------------------------------------------------------------------------

const measureSecondsHelper =
  (onDuration: (seconds: number, outcome: "ok" | "error") => void) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    Effect.suspend(() => {
      const start = Date.now();
      return effect.pipe(
        Effect.tap(() => Effect.sync(() => onDuration((Date.now() - start) / 1_000, "ok"))),
        Effect.tapError(() => Effect.sync(() => onDuration((Date.now() - start) / 1_000, "error"))),
      );
    });

/** Time `claimService.lookup` into the `cire.claim.lookup.duration` histogram. */
export const measureClaimLookup = measureSecondsHelper((seconds, outcome) =>
  claimLookupDuration.record(seconds, { result: outcome }),
);

/** Time the S2S resolve into `cire.account_link.resolve.duration`. The caller
 *  records the finer `not_found` outcome separately via {@link metricAccountLinkRequest}. */
export const measureAccountLinkResolve = measureSecondsHelper((seconds, outcome) =>
  accountLinkResolveDuration.record(seconds, { result: outcome }),
);

/** Re-export the canonical `Result` union for any future cire metric that needs
 *  the full HTTP-shaped outcome set rather than the bespoke unions above. */
export type { Result };
