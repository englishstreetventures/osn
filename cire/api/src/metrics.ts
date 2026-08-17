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

import type { ImageVariant, OutputFormat } from "./services/invite-image-transform";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const CIRE_METRICS = {
  // Guest claim (pre-auth credential exchange surface).
  claimAttempts: "cire.claim.attempts",
  // Turnstile bot-protection rejections (fail-closed) on the gated guest
  // surfaces (claim + rsvp). Only emitted when Turnstile is configured.
  turnstileRejected: "cire.turnstile.rejected",
  claimLookupDuration: "cire.claim.lookup.duration",
  // Guest sessions.
  sessionCreated: "cire.session.created",
  // Scheduled expired-session sweep (cron).
  sessionSwept: "cire.session.swept",
  // Organiser sessions, minted by the OSN OIDC callback.
  organiserSessionCreated: "cire.organiser_session.created",
  // Scheduled expired-organiser-session sweep (cron).
  organiserSessionSwept: "cire.organiser_session.swept",
  // Back-channel revocation of an organiser's sessions (OSN-side revoke /
  // account-delete calling the internal endpoint).
  organiserSessionRevoked: "cire.organiser_session.revoked",
  // OIDC sign-in outcomes, one per completed leg of the redirect flow.
  oidcLogin: "cire.oidc.login",
  // Scheduled guest-data retention sweep (cron) — deletes guest PII 1 year
  // after a wedding's final event.
  guestDataSwept: "cire.guest_data.swept",
  // Scheduled expired vendor-claim-token sweep (cron).
  vendorClaimsSwept: "cire.vendor_claims.swept",
  // Scheduled abandoned-preview sweep (cron) — imports rows stuck in `preview`
  // past the staleness window, plus their uploaded-sheet R2 objects.
  stalePreviewsSwept: "cire.imports.previews_swept",
  // R2 objects reclaimed by a sweep/delete flow that orphaned them (today: the
  // retention sweep deleting expired weddings' uploaded sheets + invite images).
  r2ObjectsSwept: "cire.r2.objects.swept",
  // Organiser host-code (invite preview) provisioning.
  hostCodeEnsured: "cire.host_code.ensured",
  // RSVP.
  rsvpUpserted: "cire.rsvp.upserted",
  rsvpBatchSize: "cire.rsvp.batch.size",
  // Guest RSVP submits refused before any write.
  rsvpBlocked: "cire.rsvp.blocked",
  // Organiser spreadsheet import.
  importApplied: "cire.import.applied",
  importRows: "cire.import.rows",
  importReverted: "cire.import.reverted",
  importParseRejected: "cire.import.parse.rejected",
  // Invite builder.
  inviteSaved: "cire.invite.saved",
  inviteAssetUploaded: "cire.invite.asset.uploaded",
  inviteAssetSize: "cire.invite.asset.size",
  // On-the-fly image transform on the public serve path (Cloudflare Images).
  imageTransform: "cire.image.transform",
  // Guest account-linking (OSN bridge).
  accountLinkRequests: "cire.account_link.requests",
  accountLinkUnlinks: "cire.account_link.unlinks",
  accountLinkResolveDuration: "cire.account_link.resolve.duration",
  // CSRF origin guard (C5 / S-L3).
  originGuardRejections: "cire.origin_guard.rejections",
  // Per-family claim-code regeneration (C2).
  familyCodeRegenerated: "cire.family_code.regenerated",
  // Bulk wedding-wide claim-code re-mint onto a new style (C3).
  weddingReminted: "cire.wedding.reminted",
  // Family invite-code marked "shared" (organiser copied the message).
  familyCodeShared: "cire.family_code.shared",
  // Family deactivated / reactivated (organiser cut off / restored a withdrawn
  // invite's claim code).
  familyDeactivated: "cire.family.deactivated",
  // Guest opened the invite for the FIRST time (an actual family-code claim,
  // host-preview excluded) — the reliable "Opened" signal, distinct from
  // `familyCodeShared` (the false-positive-prone organiser-copied "Sent").
  inviteOpened: "cire.invite.opened",
  // Organiser wedding creation (multi-wedding portal).
  weddingCreated: "cire.wedding.created",
  // Organiser wedding-profile (Settings) saves.
  weddingSettingsSaved: "cire.wedding.settings.saved",
  // Settings writes refused because a non-owner reached past the RSVP-by date.
  settingsOwnerOnlyRefused: "cire.wedding.settings.owner_only_refused",
  // Co-host management (add/remove a wedding host by OSN handle).
  hostAdded: "cire.host.added",
  hostRemoved: "cire.host.removed",
  // Co-host role changes (owner flips a host between editor and viewer).
  hostRoleChanged: "cire.host.role_changed",
  // S2S osn-api handle→profile resolve latency (the ARC call for add-host).
  hostResolveDuration: "cire.host.resolve.duration",
  // CSP violation reports posted by guests' browsers to the public collector
  // (`POST /api/csp-report`). Counted by the violated effective-directive only
  // (a small fixed set) — NEVER the blocked URI (unbounded).
  cspReport: "cire.csp.report",
  // Gift registry — organiser item writes and gift-log thank-you toggles. Both
  // are attributed by ACTION only; no weddingId, itemId or familyId ever reaches
  // a metric attribute (those belong in spans + logs).
  registryItemWrite: "cire.registry.item.write",
  registryGift: "cire.registry.gift",
  // Link preview — the one outbound fetch a user's input aims. The result
  // attribute is how a spike in refused destinations becomes visible.
  registryLinkPreview: "cire.registry.link_preview",
  // Saving a registry item's picture into R2 — an upload from the organiser's
  // machine, or a copy of an image they picked off a shop page. `source` keeps
  // the two apart (only one of them spends our network on a user's URL) and
  // `result` says how it ended. Neither is per-wedding.
  registryImageSave: "cire.registry.image.save",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes — bounded string-literal unions ONLY.
// ---------------------------------------------------------------------------

/** Outcome of a guest claim attempt. `rate_limited` is gated upstream by the
 *  per-IP limiter (429 before the handler) and reserved for that call-site. */
export type ClaimResult = "ok" | "invalid_credentials" | "rate_limited" | "error";

/** Turnstile-gated guest surface. Bounded literal union — never a raw path. */
export type TurnstileEndpoint = "claim" | "rsvp";

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

/** Why the origin guard rejected a state-changing request (C5 / S-L3). */
export type OriginRejectReason = "missing" | "mismatch";

/** Outcome of a per-family claim-code regeneration (C2). */
export type FamilyCodeRegenResult = "ok" | "error";

/** Outcome of a bulk wedding-wide claim-code re-mint (C3). */
export type WeddingRemintResult = "ok" | "error";

/** Outcome of marking a family's invite code "shared". */
export type FamilyCodeSharedResult = "ok" | "error";

/** Outcome of toggling a family's deactivation. `action` records which way the
 *  toggle went so the metric distinguishes cut-offs from restores. */
export type FamilyDeactivatedResult = "ok" | "error";
export type FamilyDeactivateAction = "deactivate" | "reactivate";

/** Outcome of recording a first guest open of an invite (best-effort write). */
export type InviteOpenedResult = "ok" | "error";

/** Outcome of an organiser wedding creation. */
export type WeddingCreatedResult = "ok" | "error";

/** Outcome of a wedding-profile (Settings) save. Validation rejections are the
 *  schema's 400 upstream; `error` is a write failure. */
export type WeddingSettingsSavedResult = "ok" | "error";

/** A settings save refused by the field-level owner check — a non-owner patch
 *  that reached past the RSVP-by deadline. Deliberately ATTRIBUTE-FREE: the
 *  refused field names are a closed set, but putting them on a metric would
 *  still multiply series for no operational gain, and the log line beside it
 *  already carries them (third observability rule — no unbounded attributes).
 *  The portal only ever sends the deadline pair, so a nonzero count means a
 *  stale tab or a hand-crafted call. */

/** Outcome of adding a co-host by handle. Mirrors the route's response branches. */
export type HostAddResult =
  | "ok"
  | "handle_not_found"
  | "osn_unavailable"
  | "already_host"
  | "owner_is_host"
  // The wedding is at MAX_HOSTS_PER_WEDDING. Worth its own label rather than
  // folding into `error`: a rise here is the signal that someone is trying to
  // create seats in bulk, which is the abuse the cap exists to bound.
  | "host_cap_reached"
  | "disabled"
  | "error";

/** Outcome of removing a co-host. */
export type HostRemoveResult = "ok" | "error";

/** Outcome of changing a co-host's role (editor ↔ viewer). */
export type HostRoleChangeResult = "ok" | "not_found" | "error";

/**
 * The CSP directive a violation report names, reduced to a BOUNDED label so it
 * is safe as a metric attribute (CSP directive names are a small fixed set; a
 * browser-supplied value outside it — or a missing one — collapses to `other`).
 * The full violated/effective-directive string (which can carry a source
 * expression) is logged, never used as a metric dimension.
 */
export type CspDirective =
  | "default-src"
  | "script-src"
  | "script-src-elem"
  | "script-src-attr"
  | "style-src"
  | "style-src-elem"
  | "style-src-attr"
  | "img-src"
  | "font-src"
  | "connect-src"
  | "frame-src"
  | "frame-ancestors"
  | "object-src"
  | "media-src"
  | "worker-src"
  | "manifest-src"
  | "base-uri"
  | "form-action"
  | "child-src"
  | "other";

type ClaimAttemptsAttrs = { result: ClaimResult };
type ClaimLookupDurationAttrs = { result: "ok" | "error" };
type SessionCreatedAttrs = { result: "ok" | "error" };
type SessionSweptAttrs = { result: "ok" | "error" };

type VendorClaimsSweptAttrs = { result: "ok" | "error" };

type StalePreviewsSweptAttrs = { result: "ok" | "error" };
type OrganiserSessionCreatedAttrs = { result: "ok" | "error" };
type OrganiserSessionSweptAttrs = { result: "ok" | "error" };
/** Back-channel revocation (OSN-side revoke / account-delete) outcome. */
type OrganiserSessionRevokedAttrs = { result: "ok" | "error" | "unauthorised" | "disabled" };
/**
 * Which leg of the OIDC redirect flow ended, and how. Closed set — never carry
 * a client id, profile id, or the provider's error string, all of which are
 * unbounded.
 *
 * `start` — we redirected the browser to the OSN authorize endpoint.
 * `callback_ok` — the code exchanged, the ID token verified, a session exists.
 * `provider_error` — OSN handed us back an `error=` instead of a code.
 * `state_mismatch` — no transaction cookie, or its `state` did not match.
 * `exchange_failed` — the back-channel token request was refused or unreachable.
 * `token_invalid` — the ID token failed verification, or lacked a profile id.
 * `bad_request` — the caller's own inputs were wrong (e.g. a foreign
 *   `return_to`); nothing reached the provider.
 */
export type OidcLoginOutcome =
  | "start"
  | "callback_ok"
  | "provider_error"
  | "state_mismatch"
  | "exchange_failed"
  | "token_invalid"
  | "bad_request";
type OidcLoginAttrs = { outcome: OidcLoginOutcome };
type GuestDataSweptAttrs = { result: "ok" | "error" };
/** Which cire R2 bucket the swept objects came from — bounded label, never a key. */
export type R2BucketAttr = "sheets" | "assets";
type R2ObjectsSweptAttrs = { bucket: R2BucketAttr; result: "ok" | "error" };
type HostCodeEnsuredAttrs = { result: "ok" | "error" };
/** Who wrote the RSVP — bounded label, never a per-guest/organiser id.
 *  `guest` (self-submitted via the invite) vs `organiser` (phone/paper RSVP
 *  recorded on the guest's behalf; `consent_source='organiser_attested'`). */
export type RsvpWriter = "guest" | "organiser";
type RsvpUpsertedAttrs = { status: RsvpStatus; source: RsvpWriter; result: "ok" | "error" };
/** Why a guest RSVP submit was refused before reaching the write — bounded set,
 *  one label per gate on the route. `deadline` = the wedding's RSVP-by date has
 *  passed; `preview` = the organiser's host-preview family, which never writes. */
export type RsvpBlockedReason = "deadline" | "preview";
type RsvpBlockedAttrs = { reason: RsvpBlockedReason };
/** Which organiser write touched a registry item. Bounded, one per route. */
export type RegistryItemAction = "create" | "update" | "remove";
type RegistryItemWriteAttrs = { action: RegistryItemAction };
/** What happened to a gift-log row. `thanked`/`unthanked` are the toggle's two
 *  directions — worth separating, since a couple un-thanking in bulk is a
 *  different (and more suspicious) signal than thanking. */
export type RegistryGiftAction = "thanked" | "unthanked";
type RegistryGiftAttrs = { action: RegistryGiftAction };
/** How a link-preview attempt ended. `blocked` is the SSRF guard refusing a
 *  destination — a sustained rise in it is someone probing, not a shop being
 *  slow, which is why it is its own value rather than folded into a failure. */
export type RegistryLinkPreviewResult =
  | "ok"
  | "blocked"
  | "fetch_failed"
  | "unusable_content"
  | "no_images";
type RegistryLinkPreviewAttrs = { result: RegistryLinkPreviewResult };
/** Where a saved registry picture came from. Two values, forever. */
export type RegistryImageSource = "upload" | "url";
/** How saving one ended. `blocked` is the SSRF guard refusing the picked URL;
 *  `unsupported_type` is the magic-byte sniff refusing bytes that are not one of
 *  the three image types (whatever the server claimed they were); `too_large` is
 *  the byte cap. Same reasoning as the preview counter: a refusal is a different
 *  signal from a failure, so it is its own value. */
export type RegistryImageSaveResult =
  | "ok"
  | "blocked"
  | "fetch_failed"
  | "unsupported_type"
  | "too_large"
  | "error";
type RegistryImageSaveAttrs = { source: RegistryImageSource; result: RegistryImageSaveResult };
type ImportSimpleAttrs = { result: "ok" | "error" };
type ImportRowsAttrs = { entity: ImportEntity };
type ImportParseRejectedAttrs = { reason: ParseRejectReason };
type InviteSimpleAttrs = { result: "ok" | "error" };

/**
 * Outcome of a public image serve:
 *  - `cache_hit`   — served from the Worker Cache API; the (billed) Images
 *                    binding was NOT invoked. The cost win we instrument for.
 *  - `transformed` — cache miss; the Images binding produced the requested
 *                    variant (and the result was written back to the cache).
 *  - `original`    — fell back to the raw R2 bytes because the binding was
 *                    absent (local/dev/tests) or the transform failed.
 * `variant` + `format` are the bounded unions from the transform module — never
 * the slug or any per-wedding value.
 */
type ImageTransformAttrs = {
  result: "cache_hit" | "transformed" | "original";
  variant: ImageVariant;
  format: OutputFormat;
};
type AccountLinkRequestsAttrs = { result: AccountLinkResult };
type AccountLinkUnlinksAttrs = { result: "ok" | "error" };
type AccountLinkResolveDurationAttrs = { result: ResolveResult };
type OriginGuardRejectionsAttrs = { reason: OriginRejectReason };
type FamilyCodeRegeneratedAttrs = { result: FamilyCodeRegenResult };
type WeddingRemintedAttrs = { result: WeddingRemintResult; style: "simple" | "secure" };
type FamilyCodeSharedAttrs = { result: FamilyCodeSharedResult };
type FamilyDeactivatedAttrs = { action: FamilyDeactivateAction; result: FamilyDeactivatedResult };
type InviteOpenedAttrs = { result: InviteOpenedResult };
type WeddingCreatedAttrs = { result: WeddingCreatedResult };
type WeddingSettingsSavedAttrs = { result: WeddingSettingsSavedResult };
type HostAddedAttrs = { result: HostAddResult };
type HostRemovedAttrs = { result: HostRemoveResult };
type HostRoleChangedAttrs = { result: HostRoleChangeResult };
type HostResolveDurationAttrs = { result: ResolveResult };
type CspReportAttrs = { effectiveDirective: CspDirective };

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

const sessionSwept = createCounter<SessionSweptAttrs>({
  name: CIRE_METRICS.sessionSwept,
  description:
    "Expired guest sessions deleted by the scheduled sweeper — increment is the row count, so the sum tracks reclaimed rows",
  unit: "{session}",
});

const organiserSessionCreated = createCounter<OrganiserSessionCreatedAttrs>({
  name: CIRE_METRICS.organiserSessionCreated,
  description: "Organiser session-cookie creations after an OSN OIDC sign-in, by outcome",
  unit: "{session}",
});

const organiserSessionSwept = createCounter<OrganiserSessionSweptAttrs>({
  name: CIRE_METRICS.organiserSessionSwept,
  description:
    "Expired organiser sessions deleted by the scheduled sweeper — increment is the row count, so the sum tracks reclaimed rows",
  unit: "{session}",
});

const oidcLogin = createCounter<OidcLoginAttrs>({
  name: CIRE_METRICS.oidcLogin,
  description: "OSN OIDC sign-in legs, by outcome",
  unit: "{attempt}",
});

const organiserSessionRevoked = createCounter<OrganiserSessionRevokedAttrs>({
  name: CIRE_METRICS.organiserSessionRevoked,
  description:
    "Back-channel organiser-session revocations via the internal endpoint (OSN-side revoke / account-delete), by outcome",
  unit: "{revocation}",
});

const guestDataSwept = createCounter<GuestDataSweptAttrs>({
  name: CIRE_METRICS.guestDataSwept,
  description:
    "Guest rows deleted by the scheduled retention sweep (1 year after a wedding's final event) — increment is the row count, so the sum tracks reclaimed guest records",
  unit: "{guest}",
});

const vendorClaimsSwept = createCounter<VendorClaimsSweptAttrs>({
  name: CIRE_METRICS.vendorClaimsSwept,
  description:
    "Expired vendor-claim tokens deleted by the scheduled sweep — increment is the row count, so the sum tracks reclaimed rows",
  unit: "{claim}",
});

const stalePreviewsSwept = createCounter<StalePreviewsSweptAttrs>({
  name: CIRE_METRICS.stalePreviewsSwept,
  description:
    "Abandoned preview change rows (never applied within the staleness window) deleted by the scheduled sweep — increment is the row count",
  unit: "{preview}",
});

const r2ObjectsSwept = createCounter<R2ObjectsSweptAttrs>({
  name: CIRE_METRICS.r2ObjectsSwept,
  description:
    "R2 objects reclaimed when a sweep/delete flow removed the D1 rows referencing them (retention sweep: uploaded guest sheets in cire-sheets + invite images in cire-assets) — increment is the object count, so the sum tracks reclaimed objects per bucket",
  unit: "{object}",
});

const hostCodeEnsured = createCounter<HostCodeEnsuredAttrs>({
  name: CIRE_METRICS.hostCodeEnsured,
  description: "Organiser host-code (invite preview) find-or-create calls, by outcome",
  unit: "{ensure}",
});

const rsvpUpserted = createCounter<RsvpUpsertedAttrs>({
  name: CIRE_METRICS.rsvpUpserted,
  description: "RSVP upserts (one per (guest,event) pair), by terminal status + writer",
  unit: "{rsvp}",
});

const registryItemWrite = createCounter<RegistryItemWriteAttrs>({
  name: CIRE_METRICS.registryItemWrite,
  description: "Organiser registry item writes, by action",
  unit: "{write}",
});

const registryGift = createCounter<RegistryGiftAttrs>({
  name: CIRE_METRICS.registryGift,
  description: "Registry gift-log thank-you toggles, by direction",
  unit: "{gift}",
});

const registryLinkPreview = createCounter<RegistryLinkPreviewAttrs>({
  name: CIRE_METRICS.registryLinkPreview,
  description: "Registry link-preview attempts, by outcome",
  unit: "{preview}",
});

const registryImageSave = createCounter<RegistryImageSaveAttrs>({
  name: CIRE_METRICS.registryImageSave,
  description: "Registry item image saves, by source + outcome",
  unit: "{save}",
});

const rsvpBlocked = createCounter<RsvpBlockedAttrs>({
  name: CIRE_METRICS.rsvpBlocked,
  description: "Guest RSVP submits refused before any write, by gate",
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

const imageTransform = createCounter<ImageTransformAttrs>({
  name: CIRE_METRICS.imageTransform,
  description:
    "Public invite-image serves, by whether the response came from the Worker Cache API (cache_hit), the Cloudflare Images binding produced a variant (transformed), or we fell back to the R2 original (original), plus the resolved variant + output format",
  unit: "{serve}",
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

const originGuardRejections = createCounter<OriginGuardRejectionsAttrs>({
  name: CIRE_METRICS.originGuardRejections,
  description: "State-changing requests rejected by the CSRF origin guard, by reason",
  unit: "{rejection}",
});

const familyCodeRegenerated = createCounter<FamilyCodeRegeneratedAttrs>({
  name: CIRE_METRICS.familyCodeRegenerated,
  description: "Organiser-triggered per-family claim-code regenerations, by outcome",
  unit: "{regeneration}",
});

const weddingReminted = createCounter<WeddingRemintedAttrs>({
  name: CIRE_METRICS.weddingReminted,
  description:
    "Bulk wedding-wide claim-code re-mints onto a new style (C3), by outcome + target style",
  unit: "{remint}",
});

const familyCodeShared = createCounter<FamilyCodeSharedAttrs>({
  name: CIRE_METRICS.familyCodeShared,
  description:
    "Families marked 'shared' when the organiser copied their invite message, by outcome",
  unit: "{share}",
});

const familyDeactivated = createCounter<FamilyDeactivatedAttrs>({
  name: CIRE_METRICS.familyDeactivated,
  description:
    "Family deactivate / reactivate toggles (organiser cutting off or restoring a withdrawn invite's claim code), by action + outcome",
  unit: "{toggle}",
});

const inviteOpened = createCounter<InviteOpenedAttrs>({
  name: CIRE_METRICS.inviteOpened,
  description:
    "First real guest opens of a family invite (an actual claim, host-preview excluded), by outcome — the reliable 'Opened' signal distinct from the organiser-copied 'Sent'",
  unit: "{open}",
});

const weddingCreated = createCounter<WeddingCreatedAttrs>({
  name: CIRE_METRICS.weddingCreated,
  description: "Organiser wedding creations (multi-wedding portal), by outcome",
  unit: "{wedding}",
});

const weddingSettingsSaved = createCounter<WeddingSettingsSavedAttrs>({
  name: CIRE_METRICS.weddingSettingsSaved,
  description: "Wedding-profile (Settings) saves, by outcome",
  unit: "{save}",
});

const settingsOwnerOnlyRefused = createCounter<Record<string, never>>({
  name: CIRE_METRICS.settingsOwnerOnlyRefused,
  description: "Settings writes refused by the field-level owner check",
  unit: "{refusal}",
});

const hostAdded = createCounter<HostAddedAttrs>({
  name: CIRE_METRICS.hostAdded,
  description: "Co-host add-by-handle attempts, by outcome",
  unit: "{host}",
});

const hostRemoved = createCounter<HostRemovedAttrs>({
  name: CIRE_METRICS.hostRemoved,
  description: "Co-host removals, by outcome",
  unit: "{host}",
});

const hostRoleChanged = createCounter<HostRoleChangedAttrs>({
  name: CIRE_METRICS.hostRoleChanged,
  description: "Co-host role changes (editor ↔ viewer), by outcome",
  unit: "{host}",
});

const hostResolveDuration = createHistogram<HostResolveDurationAttrs>({
  name: CIRE_METRICS.hostResolveDuration,
  description: "S2S osn-api handle→profile resolve latency (the ARC call for add-host)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const cspReport = createCounter<CspReportAttrs>({
  name: CIRE_METRICS.cspReport,
  description:
    "CSP violation reports posted by guests' browsers to the public collector, by the bounded effective-directive label (the blocked URI is NEVER an attribute — it is logged, reduced to origin)",
  unit: "{report}",
});

// ---------------------------------------------------------------------------
// Recording helpers — the ONLY way cire code should emit metrics.
// ---------------------------------------------------------------------------

export const metricClaimAttempt = (result: ClaimResult): void => claimAttempts.inc({ result });

const turnstileRejected = createCounter<{ endpoint: TurnstileEndpoint }>({
  name: CIRE_METRICS.turnstileRejected,
  description: "Guest requests rejected by Turnstile siteverify (fail-closed), by surface",
  unit: "{rejection}",
});

/** Records a fail-closed Turnstile rejection on a configured guest gate. */
export const metricTurnstileRejected = (endpoint: TurnstileEndpoint): void =>
  turnstileRejected.inc({ endpoint });

export const metricSessionCreated = (result: "ok" | "error"): void =>
  sessionCreated.inc({ result });

/** Record a sweep: on success `count` is the number of expired rows deleted, so
 *  the counter sum tracks reclaimed sessions over time. A failed sweep records a
 *  single `error` increment. */
export const metricSessionSwept = (result: "ok" | "error", count = 1): void =>
  sessionSwept.add(count, { result });

export const metricOrganiserSessionCreated = (result: "ok" | "error"): void =>
  organiserSessionCreated.inc({ result });

/** Same shape as `metricSessionSwept`, for the organiser table. */
export const metricOrganiserSessionSwept = (result: "ok" | "error", count = 1): void =>
  organiserSessionSwept.add(count, { result });

/** Record a back-channel revocation attempt on the internal endpoint. */
export const metricOrganiserSessionRevoked = (
  result: OrganiserSessionRevokedAttrs["result"],
): void => organiserSessionRevoked.inc({ result });

/** Record one leg of an OIDC sign-in. See `OidcLoginOutcome` for the values. */
export const metricOidcLogin = (outcome: OidcLoginOutcome): void => oidcLogin.inc({ outcome });

/** Record a retention sweep: on success `count` is the number of guest rows
 *  deleted, so the counter sum tracks reclaimed guest records over time. A
 *  failed sweep records a single `error` increment. */
export const metricGuestDataSwept = (result: "ok" | "error", count = 1): void =>
  guestDataSwept.add(count, { result });

/** Same shape as `metricSessionSwept`, for expired vendor-claim tokens. */
export const metricVendorClaimsSwept = (result: "ok" | "error", count = 1): void =>
  vendorClaimsSwept.add(count, { result });

/** Same shape as `metricSessionSwept`, for abandoned preview change rows. */
export const metricStalePreviewsSwept = (result: "ok" | "error", count = 1): void =>
  stalePreviewsSwept.add(count, { result });

/** Record an R2-object reap: `count` is the number of objects in this request,
 *  so the counter sum tracks reclaimed objects per bucket. `ok` increments the
 *  successfully-deleted count; `error` the failed (orphaned) count. */
export const metricR2ObjectsSwept = (
  bucket: R2BucketAttr,
  result: "ok" | "error",
  count = 1,
): void => r2ObjectsSwept.add(count, { bucket, result });

export const metricHostCodeEnsured = (result: "ok" | "error"): void =>
  hostCodeEnsured.inc({ result });

export const metricRsvpUpserted = (
  status: RsvpStatus,
  source: RsvpWriter,
  result: "ok" | "error",
): void => rsvpUpserted.inc({ status, source, result });

export const metricRsvpBlocked = (reason: RsvpBlockedReason): void => rsvpBlocked.inc({ reason });

export const metricRegistryItemWrite = (action: RegistryItemAction): void =>
  registryItemWrite.inc({ action });

export const metricRegistryGift = (action: RegistryGiftAction): void =>
  registryGift.inc({ action });

export const metricRegistryLinkPreview = (result: RegistryLinkPreviewResult): void =>
  registryLinkPreview.inc({ result });

export const metricRegistryImageSave = (
  source: RegistryImageSource,
  result: RegistryImageSaveResult,
): void => registryImageSave.inc({ source, result });

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

/** Record a public image serve: `cache_hit` when served from the Worker Cache
 *  API (binding not invoked), `transformed` when the Images binding produced the
 *  variant, `original` when we fell back to the raw R2 bytes. */
export const metricImageTransform = (
  result: "cache_hit" | "transformed" | "original",
  variant: ImageVariant,
  format: OutputFormat,
): void => imageTransform.inc({ result, variant, format });

export const metricAccountLinkRequest = (result: AccountLinkResult): void =>
  accountLinkRequests.inc({ result });

export const metricAccountLinkUnlink = (result: "ok" | "error"): void =>
  accountLinkUnlinks.inc({ result });

export const metricOriginGuardRejection = (reason: OriginRejectReason): void =>
  originGuardRejections.inc({ reason });

export const metricFamilyCodeRegenerated = (result: FamilyCodeRegenResult): void =>
  familyCodeRegenerated.inc({ result });

export const metricWeddingReminted = (
  result: WeddingRemintResult,
  style: "simple" | "secure",
): void => weddingReminted.inc({ result, style });

export const metricFamilyCodeShared = (result: FamilyCodeSharedResult): void =>
  familyCodeShared.inc({ result });

/** Record a family deactivate / reactivate toggle, by which way it went + outcome. */
export const metricFamilyDeactivated = (
  action: FamilyDeactivateAction,
  result: FamilyDeactivatedResult,
): void => familyDeactivated.inc({ action, result });

/** Record a FIRST guest open of an invite (the best-effort claim-path write).
 *  `ok` = the timestamp was recorded; `error` = the best-effort write failed
 *  (the claim itself still succeeded). Host-preview opens are never recorded. */
export const metricInviteOpened = (result: InviteOpenedResult): void =>
  inviteOpened.inc({ result });

export const metricWeddingCreated = (result: WeddingCreatedResult): void =>
  weddingCreated.inc({ result });

export const metricWeddingSettingsSaved = (result: WeddingSettingsSavedResult): void =>
  weddingSettingsSaved.inc({ result });

export const metricSettingsOwnerOnlyRefused = (): void => settingsOwnerOnlyRefused.inc({});

export const metricHostAdded = (result: HostAddResult): void => hostAdded.inc({ result });

export const metricHostRemoved = (result: HostRemoveResult): void => hostRemoved.inc({ result });

export const metricHostRoleChanged = (result: HostRoleChangeResult): void =>
  hostRoleChanged.inc({ result });

/** The bounded CSP directive labels, as a runtime Set for `bucketCspDirective`. */
const CSP_DIRECTIVE_LABELS = new Set<CspDirective>([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "frame-ancestors",
  "object-src",
  "media-src",
  "worker-src",
  "manifest-src",
  "base-uri",
  "form-action",
  "child-src",
]);

/**
 * Map a browser-supplied (effective/violated) directive string onto the bounded
 * {@link CspDirective} metric label. A CSP `violated-directive` can carry the
 * source expression too (e.g. `"script-src https://evil.example"`), so we take
 * the first token, lowercase it, and only keep it if it is a known directive —
 * anything else collapses to `"other"`. This is what keeps the metric's
 * cardinality fixed regardless of what a hostile/odd client posts.
 */
export const bucketCspDirective = (directive: string | undefined): CspDirective => {
  const token = (directive ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return CSP_DIRECTIVE_LABELS.has(token as CspDirective) ? (token as CspDirective) : "other";
};

/** Record one CSP violation report, counted by its bounded effective-directive. */
export const metricCspReport = (effectiveDirective: CspDirective): void =>
  cspReport.inc({ effectiveDirective });

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

/** Time the S2S handle→profile resolve into `cire.host.resolve.duration`. The
 *  caller records the finer `not_found` outcome separately via {@link metricHostAdded}. */
export const measureHostResolve = measureSecondsHelper((seconds, outcome) =>
  hostResolveDuration.record(seconds, { result: outcome }),
);

/** Re-export the canonical `Result` union for any future cire metric that needs
 *  the full HTTP-shaped outcome set rather than the bespoke unions above. */
export type { Result };
