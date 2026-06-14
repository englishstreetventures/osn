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
export { ARC_METRICS } from "./arc-metrics";

// Recovery codes — Copenhagen Book M2
export {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./recovery";
