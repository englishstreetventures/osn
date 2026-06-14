import { importKeyFromJwk, signArcToken } from "@shared/crypto/jwk";

/**
 * Server-to-server bridge to osn-api for the optional guest account-linking
 * flow. The ONLY file in cire/api that makes an outbound S2S call to osn-api.
 *
 * Why this is hand-rolled rather than reusing pulse/osn `outbound-arc.ts`:
 * those helpers import the `@shared/crypto` barrel (which pulls
 * `@osn/db` → `bun:sqlite`) and `@shared/observability` (the node
 * OpenTelemetry SDK) — neither bundles for Cloudflare Workers. cire/api runs
 * on workerd, so it mints ARC tokens via the DB-free, metric-free
 * `@shared/crypto/jwk` subpath and uses the global `fetch`.
 *
 * Key distribution: cire holds a stable ES256 private key (the
 * `CIRE_API_ARC_PRIVATE_KEY` wrangler secret); the matching public key is
 * pre-registered in osn-api's `service_accounts` table under serviceId
 * `cire-api` with the `graph:read` scope. Workers have no long-lived process,
 * so the ephemeral-key + startup self-registration + rotation dance that
 * pulse-api uses does not apply here — see `[[wiki/systems/cire-auth]]`.
 */

const ARC_ISSUER = "cire-api";
const ARC_AUDIENCE = "osn-api";
const ARC_SCOPE = "graph:read";

/** Outcome of resolving an OSN profile id to its owning account id. */
export type OsnAccountResolution =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: "profile_not_found" };

/**
 * Resolves the OSN access-token `sub` (a profile id, `usr_*`) to the OSN
 * account id (`acc_*`) that owns it. Returns `{ ok: false }` when osn-api
 * reports the profile does not exist; throws on any transport/infra failure
 * so the caller can distinguish "not found" from "osn unavailable".
 */
export type OsnAccountResolver = (profileId: string) => Promise<OsnAccountResolution>;

export interface ArcResolverConfig {
  /** Base URL of osn-api (no trailing slash), e.g. `https://api.osn.example`. */
  osnApiUrl: string;
  /** cire-api's ARC signing key, already imported from its JWK. */
  arcPrivateKey: CryptoKey;
  /** The `kid` matching the public key registered with osn-api. */
  arcKeyId: string;
}

/**
 * Builds an {@link OsnAccountResolver} backed by a real ARC-authenticated call
 * to `GET /graph/internal/profile-account`. account id is account-level
 * (not profile-level) so any of a user's OSN profiles can later surface the
 * linked invitation in Pulse.
 */
export function createArcAccountResolver(config: ArcResolverConfig): OsnAccountResolver {
  const base = config.osnApiUrl.replace(/\/+$/, "");

  return async (profileId) => {
    const token = await signArcToken(config.arcPrivateKey, {
      iss: ARC_ISSUER,
      aud: ARC_AUDIENCE,
      scope: ARC_SCOPE,
      kid: config.arcKeyId,
    });

    const res = await fetch(
      `${base}/graph/internal/profile-account?profileId=${encodeURIComponent(profileId)}`,
      { headers: { authorization: `ARC ${token}` } },
    );

    if (res.status === 404) {
      return { ok: false, reason: "profile_not_found" };
    }
    if (!res.ok) {
      // Surface as a throw so the service maps it to `osn_unavailable` (500),
      // distinct from the profile-not-found path above.
      throw new Error(`osn-api GET /graph/internal/profile-account returned ${res.status}`);
    }

    const data = (await res.json()) as { accountId?: unknown };
    if (typeof data.accountId !== "string" || data.accountId.length === 0) {
      throw new Error("osn-api profile-account response missing accountId");
    }
    return { ok: true, accountId: data.accountId };
  };
}

/**
 * Builds the resolver from raw env material (JWK string + kid + base URL),
 * importing the ES256 private key. Returns `null` when any piece is absent so
 * a deployment without the ARC secret simply has account-linking disabled
 * (the POST endpoint then answers 503) rather than failing to boot — linking
 * is an additive, opt-in surface.
 */
export async function createAccountResolverFromEnv(env: {
  osnApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<OsnAccountResolver | null> {
  if (!env.osnApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) {
    return null;
  }
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk);
  return createArcAccountResolver({
    osnApiUrl: env.osnApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}
