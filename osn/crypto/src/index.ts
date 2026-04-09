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
  // Token lifecycle
  createArcToken,
  verifyArcToken,
  // Public key resolution (Effect-based)
  resolvePublicKey,
  clearPublicKeyCache,
  // Token cache
  getOrCreateArcToken,
  clearTokenCache,
  evictExpiredTokens,
  tokenCacheSize,
} from "./arc";

// ARC observability — metric name consts; emitted by the arc.ts module itself.
export { ARC_METRICS } from "./arc-metrics";
