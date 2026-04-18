/**
 * Canonical string-literal unions for common metric attributes.
 *
 * Rule: every metric attribute value MUST be a bounded union (closed set
 * of strings known at compile time). This is how we prevent cardinality
 * explosions — the type system rejects `profileId: string`, `requestId: string`,
 * or any other unbounded field.
 *
 * If you need a new union, add it here and export it. Do NOT widen any
 * existing union without thinking about cardinality impact.
 */

/** Generic outcome for any operation. Keep the set small. */
export type Result =
  | "ok"
  | "error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "validation_error"
  | "conflict";

/** Auth methods supported by OSN Core. */
export type AuthMethod =
  | "passkey"
  | "otp"
  | "magic_link"
  | "recovery_code"
  | "refresh"
  | "password";

/** Registration funnel steps. */
export type RegisterStep = "begin" | "otp_verify" | "passkey_enroll" | "complete";

/** ARC token verification outcomes — used for S2S security dashboards. */
export type ArcVerifyResult =
  | "ok"
  | "expired"
  | "bad_signature"
  | "unknown_issuer"
  | "scope_denied"
  | "audience_mismatch"
  | "malformed";

/** Social graph state-changing actions. */
export type GraphConnectionAction = "request" | "accept" | "reject" | "remove";

/** Social graph block actions. */
export type GraphBlockAction = "add" | "remove";

/** Social graph close-friend actions. */
export type GraphCloseFriendAction = "add" | "remove";

/** Event lifecycle states (mirrors Pulse events schema). */
export type EventStatus = "upcoming" | "ongoing" | "finished" | "cancelled";

/** Organisation CRUD actions. */
export type OrgAction = "create" | "update" | "delete";

/** Organisation membership state-changing actions. */
export type OrgMemberAction = "add" | "remove" | "update_role";

/** Profile switching actions (P2 multi-account). */
export type ProfileSwitchAction = "switch" | "list";

/** Profile CRUD actions (P3 multi-account). */
export type ProfileCrudAction = "create" | "delete" | "set_default";

/** Tables affected by cascade profile delete (P3). */
export type ProfileDeleteCascadeTable = "connections" | "close_friends" | "blocks" | "org_members";

/** JWKS public key cache lookup outcomes. */
export type JwksCacheResult = "hit" | "miss" | "refresh";

/**
 * Session revocation reasons — unified counter for every code path that
 * deletes a sessions row. Replaces the previous `SecurityInvalidationTrigger`
 * split so dashboards have one canonical metric to pivot on.
 *
 * - `self` — user revoked their current session via `DELETE /sessions/:id`
 * - `other` — user revoked a different device from the session list
 * - `revoke_all_others` — user nuked every other session via
 *   `POST /sessions/revoke-others`
 * - `logout` — explicit `POST /logout`
 * - `passkey_register` — automatic after a new passkey is added (H1)
 * - `recovery_code_generate` — regenerating recovery codes invalidates the
 *   previous set; surfaced here even though no sessions are deleted, so the
 *   set-rotation signal shows up on the same dashboard
 * - `recovery_code_consume` — recovery-code login wipes every session
 *   (ceremony is "log me back in everywhere else is out")
 */
export type SessionRevokeReason =
  | "self"
  | "other"
  | "revoke_all_others"
  | "logout"
  | "passkey_register"
  | "recovery_code_generate"
  | "recovery_code_consume";

/** Session management actions (list / per-device revoke). */
export type SessionManagementAction = "list" | "revoke" | "revoke_others";

/** Recovery code (Copenhagen Book M2) operation steps. */
export type RecoveryCodeStep = "generate" | "consume";

/** Recovery code consume outcomes. */
export type RecoveryCodeConsumeResult = "success" | "invalid" | "used";

/** Origin guard CSRF rejection reasons (M1). */
export type OriginGuardRejectionReason = "missing" | "mismatch";

/** Auth endpoints subject to IP-based rate limiting (S-H1). */
export type AuthRateLimitedEndpoint =
  | "register_begin"
  | "register_complete"
  | "handle_check"
  | "otp_begin"
  | "otp_complete"
  | "magic_begin"
  | "magic_verify"
  | "passkey_login_begin"
  | "passkey_login_complete"
  | "passkey_register_begin"
  | "passkey_register_complete"
  | "profile_switch"
  | "profile_list"
  | "profile_create"
  | "profile_delete"
  | "profile_set_default"
  | "recovery_generate"
  | "recovery_complete"
  | "session_list"
  | "session_revoke"
  | "session_revoke_others";
