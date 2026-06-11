import { osnAuth as honoOsnAuth } from "@shared/osn-auth-client/middleware/hono";

export type { OsnAuthOptions } from "@shared/osn-auth-client/middleware/hono";

/**
 * Verifies an OSN-issued access token (couples sign in with OSN passkeys
 * on the organiser portal). Thin wrapper over @shared/osn-auth-client so
 * cire-specific defaults can land here without touching call sites.
 */
export const osnAuth = honoOsnAuth;
