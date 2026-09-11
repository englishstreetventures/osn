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

export const RESULT_VALUES = [
  "ok",
  "error",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "validation_error",
  "conflict",
] as const;

/** Generic outcome for any operation. Keep the set small. */
export type Result = (typeof RESULT_VALUES)[number];

/**
 * Auth methods supported by OSN Core. Passkey (incl. security keys) is the only
 * primary login factor; refresh tracks token refresh cycles. The other three are
 * account recovery, and none of them is a login factor.
 *
 * `recovery_code` mints an ordinary session. `email_recovery` and
 * `totp_recovery` mint a **restricted** one — `aud: "osn-recovery"`, 15-minute
 * absolute lifetime, rejected by every verifier in this service and in the three
 * downstream services, and able to do exactly one thing: enrol a passkey. So
 * neither reinstates the OTP primary login `[[passkey-primary]]` removed; see
 * `wiki/architecture/account-recovery-factors.md` §B.
 */
export type AuthMethod =
  | "passkey"
  | "recovery_code"
  | "email_recovery"
  | "totp_recovery"
  | "refresh";

/** Registration funnel steps. */
export type RegisterStep = "begin" | "otp_verify" | "passkey_enroll" | "complete";

/** ARC token verification outcomes — used for S2S security dashboards. */
export type ArcVerifyResult =
  | "ok"
  | "expired"
  | "bad_signature"
  | "unknown_issuer"
  | "revoked_key" // kid known but revoked (or its registration expired) — distinguishable from unknown_issuer on dashboards
  | "scope_denied"
  | "audience_mismatch"
  | "malformed";

/** Social graph state-changing actions. */
export type GraphConnectionAction = "request" | "accept" | "reject" | "remove";

/** Social graph block actions. */
export type GraphBlockAction = "add" | "remove";

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
export type ProfileDeleteCascadeTable = "connections" | "blocks" | "org_members";

/** Security events that trigger session invalidation (H1). */
export type SecurityInvalidationTrigger =
  | "passkey_register"
  | "passkey_delete"
  | "email_change"
  | "recovery_code_generate"
  | "recovery_code_consume"
  // Email-OTP or TOTP recovery completed: every session on the account is
  // wiped and a restricted recovery session replaces them.
  | "account_recovered"
  // A `POST /recovery/disown` was accepted: the recovery-enrolled credentials
  // and every session on the account go, and the recovery window is cleared.
  | "recovery_disowned"
  | "session_revoke"
  | "session_revoke_all";

/** Step-up (sudo mode) factor presented by the caller. */
export type StepUpFactor = "passkey" | "otp" | "totp" | "recovery_code";

/**
 * TOTP (RFC 6238) operations, for the operation counter and the span name.
 * `verify` covers every code check — step-up today, recovery once that lands —
 * so the funnel does not have to grow a value per entry point.
 */
export type TotpOp = "enroll_begin" | "enroll_complete" | "disable" | "status" | "verify";

/**
 * Outcome of a TOTP code check. The route answers the same generic error for
 * every failure — which one it was must be visible on a dashboard and nowhere
 * on the wire, or the response becomes an oracle for whether an account has a
 * second factor.
 */
export type TotpVerifyResult =
  | "ok"
  | "invalid"
  | "replayed"
  | "not_enrolled"
  | "locked_out"
  /**
   * The stored credential could not be decrypted by any configured key, so the
   * code was never checked. Named for what is observed rather than for a cause,
   * because there are two and this cannot tell them apart: a key rotation with
   * the previous key missing or wrong, and a credential row that has been
   * tampered with or copied onto another account — the account is bound in as
   * additional authenticated data, so a copied row opens under nothing.
   *
   * Which means the rate is read against a rotation window: expected while one
   * is draining, and an INTEGRITY alarm outside one. On the wire it is the same
   * generic failure as every value above.
   */
  | "unreadable";

/**
 * Outcome of moving one TOTP credential onto the current encryption key, which
 * happens lazily on a successful verify. `ok` counts a row drained off the
 * outgoing key — the number an operator watches to know a rotation is finished;
 * `failed` means the row kept verifying but stayed where it was.
 */
export type TotpRekeyResult = "ok" | "failed";

/** Step-up ceremony steps, for attempt funnel counters. */
export type StepUpStep = "begin" | "complete";

/**
 * Purpose claim embedded in step-up tokens. Lets one token mint serve
 * multiple sensitive operations while still enforcing that each operation
 * verifies its own purpose. New entries here MUST be matched in osn-api's
 * verifier and any downstream `/internal/step-up/verify` callers.
 */
export type StepUpPurpose =
  | "recovery_generate"
  | "passkey_register"
  | "passkey_delete"
  | "email_change"
  | "security_event_ack"
  | "account_delete"
  | "account_export"
  | "totp_enroll"
  | "totp_disable"
  | "pulse_app_delete"
  | "zap_app_delete";

/** Step-up verification outcomes on protected endpoints. */
export type StepUpVerifyResult =
  | "ok"
  | "missing"
  | "invalid"
  | "expired"
  | "wrong_audience"
  | "wrong_subject"
  | "wrong_purpose"
  | "jti_replay"
  | "amr_not_allowed"
  // The factor was permitted but the credential behind it was not: a passkey
  // registered under a weaker AMR, inside its 72-hour window, asked to delete
  // an older credential or change the account email. Distinct from
  // `amr_not_allowed` so a dashboard separates "wrong factor" from "right
  // factor, wrong provenance" — those need different answers from the user.
  | "provenance_blocked";

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

/**
 * Account-recovery operation steps. The first two are the recovery-code
 * ceremony (Copenhagen Book M2); the other three are the email-OTP and TOTP
 * factors that mint a restricted recovery session.
 */
export type RecoveryCodeStep =
  | "generate"
  | "consume"
  | "email_begin"
  | "email_complete"
  | "totp_complete"
  // `POST /recovery/disown` — the "this wasn't me" lever in the recovery notice.
  | "disown";

/**
 * Why the post-recovery cooldown refused an action. Every one of these answers
 * the caller with the same generic error, so the dashboard is the only place
 * the three are told apart.
 */
export type RecoveryCooldownOutcome =
  | "second_recovery_refused"
  | "passkey_mutation_refused"
  | "email_change_refused";

/**
 * Outcome of `POST /recovery/disown`. Every one answers 202 except
 * `revoke_failed`, including `store_error` — a token that cannot be read
 * revokes nothing, and the caller must not be able to tell that apart from a
 * token that was simply wrong.
 *
 * `accepted` and `kept_last_passkey` are the only two that mean the writes
 * landed. Nothing else may be counted as the lever having fired: this is the
 * one signal that separates a real revocation from a no-op, and a disown that
 * revoked nothing while reporting success is indistinguishable from one that
 * was never needed.
 */
export type RecoveryDisownResult =
  | "accepted"
  // Bad, spent, or expired token — one bucket, because the route cannot tell
  // them apart without leaking which. A token whose single-use claim another
  // caller won lands here too: to this caller it was already spent.
  | "invalid"
  // The credentials the disown would revoke are the account's only ones. The
  // sessions still go; the last-passkey invariant wins over the revocation.
  | "kept_last_passkey"
  // The token store could not be read or claimed. Revokes nothing, answers 202.
  | "store_error"
  // The token matched and was spent, but the database refused the revocation.
  // The ONLY outcome that answers 5xx: the caller is told the lever did not
  // fire, because they are the one who can pull it again.
  | "revoke_failed";

/** Recovery code consume outcomes. */
export type RecoveryCodeConsumeResult = "success" | "invalid" | "used";

/**
 * How an enrolment from a restricted recovery session fared against the passkey
 * ceiling. Emitted once per completed enrolment, from the `complete` side only —
 * `begin` no longer reaches this decision at all, and counting both would double
 * every ceremony.
 *
 * None of the three is a refusal. A recovery enrolment is never refused for want
 * of a slot; the three values say what it cost.
 */
export type RecoveryPasskeyReclaimResult =
  // At or below the ceiling: the credential was simply added and nothing was
  // reclaimed. The ordinary shape of a first recovery at the cap.
  | "headroom_used"
  // Above the ceiling, and every credential of surplus was paid for by
  // reclaiming one this same recovery episode lent.
  | "reclaimed"
  // Above the ceiling with nothing of this episode's own left to reclaim, so
  // the ceiling gave way and the account ends above it. Nothing that predates
  // the recovery is ever taken, because it may be the only credential the owner
  // can still use. The value to alert on — not for a lockout, which no longer
  // happens here, but because an account reaching it repeatedly is accumulating
  // credentials nobody prunes.
  | "ceiling_yielded";

/**
 * Out-of-band security event kinds (M-PK1b). Mirrors the `kind` column on
 * the `security_events` table; new entries here MUST be matched by the
 * service layer, otherwise the counter attribute will fall outside the
 * bounded union.
 */
export type SecurityEventKind =
  | "recovery_code_generate"
  | "recovery_code_consume"
  // Emitted when an account crosses the recovery-code failed-attempt
  // lockout threshold (per-account, keyed on the resolved accountId).
  | "recovery_code_lockout"
  // A recovery factor (email OTP or TOTP) was accepted and a restricted
  // recovery session issued. Written in the same batch as the session wipe, so
  // the banner shows it even when the notice email is never read.
  | "account_recovered"
  // Emitted when an account crosses the failed-attempt threshold on the
  // email-OTP recovery path. Keyed on the resolved accountId, like its
  // recovery-code sibling.
  | "recovery_otp_lockout"
  | "passkey_register"
  | "passkey_delete"
  // A credential was deleted to pay for one a recovery session enrolled at the
  // passkey ceiling. Distinct from `passkey_delete` because the account holder
  // did not ask for it: the row is the only record that a credential vanished
  // through a path nobody drove.
  | "passkey_reclaimed"
  // A recovery was disowned from the notice email: the credentials it enrolled
  // and every session on the account were revoked.
  | "recovery_disowned"
  | "totp_enrolled"
  | "totp_disabled"
  | "cross_device_login"
  | "account_deletion_scheduled"
  | "account_deletion_cancelled"
  | "account_deletion_completed"
  | "app_deletion_scheduled"
  | "app_deletion_cancelled"
  | "app_deletion_completed";

/** Apps a user can opt in/out of independently (Phase 1 surfaces). */
export type AppEnrollmentApp = "pulse" | "zap";

/** Phase of the deletion lifecycle, used for histogram buckets. */
export type DeletionPhase = "soft" | "hard";

/** Outcome of a deletion request, including pre-flight rejections. */
export type DeletionRequestResult =
  | "ok"
  | "already_pending"
  | "step_up_failed"
  | "rate_limited"
  | "error";

/** Final disposition of a completed deletion lifecycle event. */
export type DeletionCompletedResult = "soft" | "hard" | "cancelled";

/** Source that triggered a deletion completion event. */
export type DeletionCompletedSource = "user" | "sweeper" | "minor_runbook" | "admin";

/** Per-bridge fan-out outcome during cross-service deletion. */
export type DeletionFanoutService = "pulse" | "zap";
export type DeletionFanoutResult = "ok" | "timeout" | "error" | "skipped";

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

/**
 * Outcome of a call to the OIDC authorization endpoint. Mirrors the OAuth
 * error codes we are allowed to emit, plus the two success shapes: straight
 * back to the relying party with a code, or handed to the consent UI.
 */
export type OidcAuthorizeResult =
  | "redirected"
  | "interaction"
  | "login_required"
  | "consent_required"
  | "access_denied"
  | "invalid_request"
  | "invalid_client"
  | "server_error";

/** Outcome of an OIDC token exchange. */
export type OidcTokenResult = "ok" | "invalid_grant" | "invalid_client" | "invalid_request";

/** Whether the relying party belongs to us. Two values — safe to dimension by. */
export type OidcClientKind = "first_party" | "third_party";

/** Auth endpoints subject to IP-based rate limiting. */
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
  | "recovery_status"
  | "recovery_complete"
  | "recovery_email_begin"
  | "recovery_email_complete"
  | "recovery_totp_complete"
  | "recovery_disown"
  | "step_up_passkey_begin"
  | "step_up_passkey_complete"
  | "step_up_otp_begin"
  | "step_up_otp_complete"
  | "step_up_totp_complete"
  | "totp_enroll_begin"
  | "totp_enroll_complete"
  | "totp_disable"
  | "totp_status"
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
  | "cross_device_reject"
  | "account_delete"
  | "account_restore"
  | "account_deletion_status"
  | "oidc_authorize"
  | "oidc_authorize_context"
  | "oidc_authorize_decision"
  | "oidc_token"
  | "oidc_connections_list"
  | "oidc_connections_revoke"
  | "oidc_client_create"
  | "oidc_client_list"
  | "oidc_client_disable";
