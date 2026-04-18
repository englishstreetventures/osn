// ARC token system — S2S (service-to-service) authentication
export {
  // Errors
  ArcTokenError,
  // Types
  type ArcTokenClaims,
  type ArcTokenPayload,
  // Key management
  generateArcKeyPair,
  exportKeyToJwk,
  importKeyFromJwk,
  thumbprintKid,
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
