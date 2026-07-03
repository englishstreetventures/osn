import type { RecoveryLockoutStore } from "../../lib/recovery-lockout-store";
import type { RotatedSessionStore } from "../../lib/rotated-session-store";
import type { AccountCapLimiter, CeremonyStores, StepUpJtiStore } from "./stores";

export interface AuthConfig {
  /** RP ID for WebAuthn (e.g. "localhost" or "example.com") */
  rpId: string;
  /** Human-readable RP name */
  rpName: string;
  /**
   * Accepted WebAuthn origin(s) — a single origin or several (e.g. one per dev
   * frontend). Passed straight to @simplewebauthn's `expectedOrigin`, which
   * matches the ceremony's origin against the string or any member of the array.
   */
  origin: string | string[];
  /** Issuer URL (JWT issuer) */
  issuerUrl: string;
  /** ES256 private key for signing access and refresh tokens */
  jwtPrivateKey: CryptoKey;
  /** ES256 public key for verifying the above */
  jwtPublicKey: CryptoKey;
  /** Key ID (RFC 7638 thumbprint) — included in JWT headers and JWKS */
  jwtKid: string;
  /** Public key as JWK object — served at /.well-known/jwks.json */
  jwtPublicKeyJwk: Record<string, unknown>;
  /**
   * Access token TTL in seconds. Default: 300 (5 minutes).
   *
   * Short TTL caps the XSS blast radius on the access token — the one
   * auth secret that still lives in localStorage after C3. The refresh
   * token is in an HttpOnly cookie so transparent silent-refresh works
   * without the user noticing the rotation.
   */
  accessTokenTtl?: number;
  /** Refresh token TTL in seconds (default: 2592000 = 30 days) */
  refreshTokenTtl?: number;
  /** OTP TTL in seconds (default: 600 = 10 min). Applies to registration, email change, and step-up OTP. */
  otpTtl?: number;
  /**
   * Step-up (sudo) token TTL in seconds. Default: 300 (5 min). Short enough
   * that a stolen step-up JWT grants only a narrow window for sensitive
   * actions — same ceiling as an access token, same threat model.
   */
  stepUpTokenTtl?: number;
  /**
   * HMAC pepper used to hash session-issuing IP addresses into
   * `sessions.ip_hash`. Must be at least 32 bytes of unguessable material
   * in non-local envs — rotating it invalidates the display "same-subnet"
   * signal, but has no effect on session validity. When unset, IP hashes
   * are not recorded (dev mode).
   */
  sessionIpPepper?: string;
  /**
   * Permitted AMR ("authentication method reference") values for
   * `/recovery/generate` step-up. The user explicitly wanted both passkey
   * and OTP flows allowed; set narrower in production if desired.
   */
  recoveryGenerateAllowedAmr?: readonly ("webauthn" | "otp")[];
  /**
   * Permitted AMR values for `DELETE /passkeys/:id` step-up. Defaults to
   * passkey-only (`["webauthn"]`) — by construction the caller already
   * has at least one passkey (the last-passkey guard fires otherwise),
   * so accepting OTP would weaken the gate without UX gain (S-L4).
   */
  passkeyDeleteAllowedAmr?: readonly ("webauthn" | "otp")[];
  /**
   * Permitted AMR values for `/passkey/register/{begin,complete}` step-up
   * when the account already has ≥1 passkey (S-H1). First-passkey
   * enrollment bypasses the gate entirely — no step-up ceremony is
   * reachable before the account has any credentials. Defaults to
   * `["webauthn", "otp"]` because a user who legitimately wants to add a
   * second device may be doing so precisely because the original is hard
   * to reach; forcing passkey-only step-up would create a chicken-and-
   * egg.
   */
  passkeyRegisterAllowedAmr?: readonly ("webauthn" | "otp")[];
  /**
   * Cluster-wide single-use guard for step-up token jtis (S-H1). Inject a
   * Redis-backed store in multi-pod deployments; otherwise the default
   * in-memory map means a captured token replays successfully once per pod.
   */
  stepUpJtiStore?: StepUpJtiStore;
  /**
   * Cluster-safe record of rotated-out session hashes for C2 reuse detection
   * (S-H1 session). Single-process deployments get the in-memory default;
   * multi-pod deployments inject a Redis-backed store so a rotation recorded
   * on one pod is visible to every other pod on subsequent /token calls.
   */
  rotatedSessionStore?: RotatedSessionStore;
  /**
   * O2: per-account recovery-code lockout counter. Defaults to in-memory;
   * inject the Redis-backed store in multi-pod deployments so the threshold
   * is enforced across pods. Keyed on the resolved accountId — see
   * `recovery-lockout-store.ts`.
   */
  recoveryLockoutStore?: RecoveryLockoutStore;
  /**
   * O3: injectable Redis-backed ceremony / pending-state stores. When omitted
   * each falls back to an in-memory `Map` (single-process only). Multi-pod
   * deployments MUST inject the Redis-backed variants so a ceremony `begin`
   * served by one pod can be `complete`d by another, and so per-account caps
   * are enforced cluster-wide rather than per-pod. The factory builds these
   * from a single `RedisClient` in `index.ts`.
   */
  ceremonyStores?: CeremonyStores;
  /**
   * O3: per-account caps, routed through the redis-rate-limiter family rather
   * than bespoke stores. `check(accountId)` returns `true` while under the cap,
   * `false` once exceeded (fixed window). Defaults to in-memory fixed-window
   * limiters with the historical bounds (profile-switch 20/hr, email-change
   * begin 3/24h). Injected from `index.ts` as Redis-backed limiters in
   * multi-pod deployments so the window is shared across pods.
   */
  profileSwitchCap?: AccountCapLimiter;
  emailChangeBeginCap?: AccountCapLimiter;
}
