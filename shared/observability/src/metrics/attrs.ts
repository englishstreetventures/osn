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

/** Auth methods supported by OSN Core. Passkey (incl. security keys) is the only primary login factor; recovery_code is the "lost device" escape hatch; refresh tracks token refresh cycles. */
export type AuthMethod = "passkey" | "recovery_code" | "refresh";

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
export type EventStatus = "upcoming" | "ongoing" | "maybe_finished" | "finished" | "cancelled";

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

/** Security events that trigger session invalidation (H1). */
export type SecurityInvalidationTrigger =
  | "passkey_register"
  | "passkey_delete"
  | "email_change"
  | "recovery_code_generate"
  | "recovery_code_consume"
  | "session_revoke"
  | "session_revoke_all";

/** Step-up (sudo mode) factor presented by the caller. */
export type StepUpFactor = "passkey" | "otp" | "recovery_code";

/** Step-up ceremony steps, for attempt funnel counters. */
export type StepUpStep = "begin" | "complete";

/** Step-up verification outcomes on protected endpoints. */
export type StepUpVerifyResult =
  | "ok"
  | "missing"
  | "invalid"
  | "expired"
  | "wrong_audience"
  | "wrong_subject"
  | "jti_replay"
  | "amr_not_allowed";

/** Session-management actions initiated by the caller. */
export type SessionAction = "list" | "revoke" | "revoke_all";

/** Rotated-session tracking store operations (C2 reuse detection). */
export type RotatedStoreAction = "track" | "check" | "revoke_family";

/** Outcome of a rotated-session store operation. */
export type RotatedStoreResult = "ok" | "hit" | "miss" | "error";

/** Rotated-session store backend. */
export type RotatedStoreBackend = "memory" | "redis";

/** Email-change ceremony steps, for funnel counters. */
export type EmailChangeStep = "begin" | "complete";

/** Recovery code (Copenhagen Book M2) operation steps. */
export type RecoveryCodeStep = "generate" | "consume";

/** Recovery code consume outcomes. */
export type RecoveryCodeConsumeResult = "success" | "invalid" | "used";

/**
 * Out-of-band security event kinds (M-PK1b). Mirrors the `kind` column on
 * the `security_events` table; new entries here MUST be matched by the
 * service layer, otherwise the counter attribute will fall outside the
 * bounded union.
 */
export type SecurityEventKind =
  | "recovery_code_generate"
  | "recovery_code_consume"
  | "passkey_register"
  | "passkey_delete"
  | "cross_device_login";

/**
 * Caller-initiated passkey management actions (M-PK). Keep the list tight —
 * this attribute appears on counter + histogram dashboards that slice by
 * action, so additions raise cardinality linearly.
 */
export type PasskeyAction = "list" | "rename" | "delete";

/** Result of an attempted security-event email notification. */
export type SecurityEventNotifyResult = "sent" | "failed" | "skipped";

/** Origin guard CSRF rejection reasons (M1). */
export type OriginGuardRejectionReason = "missing" | "mismatch";

/** Cross-device login protocol steps. */
export type CrossDeviceStep = "begin" | "poll" | "approve" | "reject";

/** Auth endpoints subject to IP-based rate limiting (S-H1). */
export type AuthRateLimitedEndpoint =
  | "register_begin"
  | "register_complete"
  | "handle_check"
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
  | "step_up_passkey_begin"
  | "step_up_passkey_complete"
  | "step_up_otp_begin"
  | "step_up_otp_complete"
  | "session_list"
  | "session_revoke"
  | "email_change_begin"
  | "email_change_complete"
  | "security_event_list"
  | "security_event_ack"
  | "passkey_list"
  | "passkey_rename"
  | "passkey_delete"
  | "cross_device_begin"
  | "cross_device_poll"
  | "cross_device_approve"
  | "cross_device_reject";
