// Pure ES256 key/JWK helpers — DB-free; also importable on Cloudflare Workers
// via `@shared/crypto/jwk` without pulling the @osn/db → bun:sqlite chain.
export {
  // Errors
  ArcTokenError,
  // Key management
  generateArcKeyPair,
  exportKeyToJwk,
  importKeyFromJwk,
  thumbprintKid,
  // Worker-safe ARC signing primitive (metric-free)
  signArcToken,
  ARC_DEFAULT_TTL_SECONDS,
} from "./jwk";

// ARC token system — S2S (service-to-service) authentication
export {
  // Types
  type ArcTokenClaims,
  type ArcTokenPayload,
  // Token lifecycle
  createArcToken,
  verifyArcToken,
  // Public key resolution (Effect-based)
  resolvePublicKey,
  clearPublicKeyCache,
  evictPublicKeyCacheEntry,
  // Token cache
  getOrCreateArcToken,
  clearTokenCache,
  evictExpiredTokens,
  tokenCacheSize,
} from "./arc";

// ARC observability — metric name consts; emitted by the arc.ts module itself.
// `metricArcTokenVerification` is additionally exported for receiver-side
// middlewares whose early-exit branches (kid unknown/revoked, registry scope
// denial) reject BEFORE `verifyArcToken` runs and would otherwise be invisible
// on the verification counter (S-L6).
export { ARC_METRICS, metricArcTokenVerification } from "./arc-metrics";

// Recovery codes — Copenhagen Book M2
export {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./recovery";
