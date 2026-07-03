/**
 * Public DTO shapes returned across the auth service surface. Pure types —
 * no runtime dependencies beyond the profile row shape.
 */

import type { Profile } from "@osn/db/schema";
import type { SecurityEventKind } from "@shared/observability/metrics";

/**
 * A session token envelope — the shape returned by `issueTokens` and consumed
 * by clients. Exposed as a named type so the first-party `/login/*` endpoints
 * can type their return shapes precisely.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Per-session metadata captured at issuance. `uaLabel` is a coarse
 * "Firefox on macOS"-style string — never the raw User-Agent. `ip` is
 * the caller's IP; it is immediately hashed via HMAC-peppered SHA-256
 * before leaving this service, never stored raw.
 */
export interface SessionMeta {
  uaLabel?: string | null;
  ip?: string | null;
}

/**
 * Public shape returned by `listAccountSessions`. The revocation handle
 * (`id`) is the first 16 hex chars of the session-token SHA-256 — enough
 * to uniquely identify a row in practice (well below any collision risk
 * for a single account) without exposing the full token hash.
 */
export interface SessionSummary {
  id: string;
  uaLabel: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  isCurrent: boolean;
}

/**
 * Public shape returned by `listUnacknowledgedSecurityEvents`. Surfaces the
 * kind, when it happened, and the coarse device context so the client banner
 * can render "your recovery codes were regenerated on Firefox on macOS —
 * was this you?" without ever exposing the raw IP or User-Agent.
 */
export interface SecurityEventSummary {
  id: string;
  kind: SecurityEventKind;
  createdAt: number;
  uaLabel: string | null;
  ipHash: string | null;
}

/**
 * Public-safe shape returned by `listPasskeys`. Deliberately omits
 * `publicKey` + `counter` (internal to the WebAuthn ceremony) and
 * `credentialId` (S-L2: not needed by the Settings UI; reduces the
 * supply-chain-attack surface for targeted-phishing exfiltration of
 * authenticator-model fingerprints). The opaque `pk_<hex>` `id` is the
 * only handle the management surface needs.
 */
export interface PasskeySummary {
  id: string;
  label: string | null;
  aaguid: string | null;
  transports: string[] | null;
  backupEligible: boolean | null;
  backupState: boolean | null;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds — null if the credential has never been used for auth. */
  lastUsedAt: number | null;
}

/**
 * A profile row enriched with the `email` from the linked `accounts` row.
 * Used throughout the auth service since the profiles table no longer carries email.
 */
export type ProfileWithEmail = Profile & { email: string };

/**
 * The publicly-safe subset of a profile returned alongside a fresh session on
 * first-party login. Strips timestamps so clients don't accidentally depend
 * on them for anything display-related.
 */
export interface PublicProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function toPublicProfile(u: Profile, email: string): PublicProfile {
  return {
    id: u.id,
    handle: u.handle,
    email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
  };
}
