import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Browser sessions for the Pulse web app, minted by the OSN OIDC login flow.
 *
 * The iOS app holds an OSN refresh token and calls this API with a bearer
 * access JWT. A browser cannot: the OSN issuer lives on `musubi.social`, a
 * different site from Pulse web, so its session cookie never rides along. Pulse
 * web therefore signs in by redirect through the OSN authorize endpoint and
 * comes back with an ID token; `pulse/api` mints this row and sets its own
 * host-scoped cookie. Same shape as cire's `organiser_sessions` — the token
 * column stores the SHA-256 hash, never the token itself.
 *
 * `osnProfileId` is the real `usr_*` id from the first-party-only
 * `osn_profile_id` claim, NOT the OIDC pairwise `sub`: every row Pulse owns
 * keys on profile ids, and so does the access JWT the iOS clients present, so
 * the two callers must resolve to the same identifier. `osnSub` keeps the
 * pairwise subject for audit and connection-revocation matching. Both are
 * opaque cross-database ids, deliberately not foreign keys.
 *
 * The four profile columns are a login-time snapshot of the ID token's claims
 * so the web chrome has a name to render without a round trip to OSN; they
 * expire with the row and are re-taken on every sign-in.
 */
export const pulseWebSessions = sqliteTable(
  "pulse_web_sessions",
  {
    id: text("id").primaryKey(), // pws_<uuid>
    token: text("token").notNull().unique(), // SHA-256 of the opaque cookie value
    osnProfileId: text("osn_profile_id").notNull(),
    osnSub: text("osn_sub").notNull(),
    email: text("email"),
    handle: text("handle"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  // profile_id serves sign-out-everywhere and the OIDC connection-revocation
  // hook; expires_at serves the sweep. Both would be full scans otherwise.
  (t) => [
    index("pulse_web_sessions_profile_idx").on(t.osnProfileId),
    index("pulse_web_sessions_expires_idx").on(t.expiresAt),
  ],
);

export type PulseWebSession = typeof pulseWebSessions.$inferSelect;
export type NewPulseWebSession = typeof pulseWebSessions.$inferInsert;
