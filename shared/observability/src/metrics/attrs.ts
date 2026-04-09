/**
 * Canonical string-literal unions for common metric attributes.
 *
 * Rule: every metric attribute value MUST be a bounded union (closed set
 * of strings known at compile time). This is how we prevent cardinality
 * explosions — the type system rejects `userId: string`, `requestId: string`,
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

/** Event lifecycle states (mirrors Pulse events schema). */
export type EventStatus = "upcoming" | "ongoing" | "finished" | "cancelled";
