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
export type AuthMethod = "passkey" | "otp" | "magic_link" | "refresh" | "password";

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
  | "profile_set_default";
