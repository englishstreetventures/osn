/**
 * Bounded metric attribute unions for `@shared/redis`.
 *
 * `RedisNamespace` is the closed set of logical key-spaces that live in Redis.
 * It is the single source of truth for the `namespace` attribute on the
 * `redis.store.keys` gauge (and any other per-namespace metric a downstream
 * service emits). Keeping it a closed union enforces the observability rule
 * "no unbounded metric attributes" — a new Redis-backed store MUST add its
 * namespace here before it can be dimensioned, which keeps cardinality
 * reviewable in one place.
 *
 * The string values mirror the key prefixes used by the stores themselves
 * (e.g. `rl:` rate-limit keys, `osn:rot-session:` rotated-session keys). They
 * are intentionally short and stable — renaming one is a metric-continuity
 * break, not just a refactor.
 */
export type RedisNamespace =
  // Phase 1–4 (pre-existing): rate limiting + cluster-safe auth state.
  | "rate_limit"
  | "rotated_session"
  | "step_up_jti"
  // O3: ceremony / pending-state stores migrated off process-local Maps.
  | "reg_challenge"
  | "login_challenge"
  | "pending_registration"
  | "step_up_challenge"
  | "step_up_otp"
  | "pending_email_change"
  | "cross_device"
  // O2: per-account recovery-code lockout counter.
  | "recovery_lockout";
