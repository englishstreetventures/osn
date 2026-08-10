import { Effect } from "effect";

/**
 * Opaque bearer-token primitives, shared by every cookie-backed session an OSN
 * relying party issues (cire's guest households and organisers, pulse's web
 * sessions, and the OIDC transaction state in between).
 *
 * The scheme is the same everywhere: a random token goes to the browser, only
 * its SHA-256 hash is stored, and lookups hash the presented value and match on
 * that.
 *
 * Deliberately its own module with only an `effect` import: `@shared/crypto`'s
 * index pulls in `@osn/db` and the observability stack, which a relying party
 * minting a cookie has no business loading.
 */

/**
 * 256 bits of `crypto.getRandomValues` entropy → base64url (no padding).
 * 43 chars; URL-safe; safe to drop straight into a Set-Cookie header or a
 * query string.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * SHA-256 hex of the raw token. The DB stores the hash so a leaked DB dump
 * cannot be replayed as a session cookie. The cookie still carries the raw
 * token — we hash on every validate/revoke lookup and match that. SHA-256 hex
 * is deterministic, so a UNIQUE index on the stored column keeps working.
 */
export function hashToken(raw: string): Effect.Effect<string> {
  return Effect.promise(() => sha256Hex(raw));
}

/** Promise-returning form, for the non-Effect callers (PKCE, cookie state). */
export async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Raw SHA-256 bytes as base64url — the shape PKCE's `code_challenge` wants. */
export async function sha256Base64Url(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
