import { importKeyFromJwk, signArcToken } from "@shared/crypto/jwk";
import { instrumentedFetch } from "@shared/observability/fetch";

/**
 * Server-to-server bridge to osn-api for the optional guest account-linking
 * flow. The ONLY file in cire/api that makes an outbound S2S call to osn-api.
 *
 * Why this is hand-rolled rather than reusing pulse/osn `outbound-arc.ts`:
 * those helpers import the `@shared/crypto` barrel (which pulls
 * `@osn/db` → `bun:sqlite`) and the node OpenTelemetry *SDK* — neither bundles
 * for Cloudflare Workers. cire/api runs on workerd, so it mints ARC tokens via
 * the DB-free, metric-free `@shared/crypto/jwk` subpath. The outbound call goes
 * through `instrumentedFetch` (from `@shared/observability/fetch`, which imports
 * only the workerd-safe `@opentelemetry/api` surface, never the SDK) so the S2S
 * request carries a W3C `traceparent`; osn-api adopts it because the call is
 * ARC-authenticated (S-H18). The wrapper leaves the `Authorization: ARC` header
 * untouched.
 *
 * Key distribution: cire holds a stable ES256 private key (the
 * `CIRE_API_ARC_PRIVATE_KEY` wrangler secret); the matching public key is
 * pre-registered in osn-api's `service_accounts` table under serviceId
 * `cire-api` with the `graph:read,graph:resolve-account` scopes. Workers have
 * no long-lived process, so the ephemeral-key + startup self-registration +
 * rotation dance that pulse-api uses does not apply here — see
 * `[[wiki/systems/cire-auth]]`.
 */

const ARC_ISSUER = "cire-api";
const ARC_AUDIENCE = "osn-api";
const ARC_SCOPE = "graph:read";
/**
 * Dedicated scope for the profileId → accountId lookup — osn-api's
 * `/graph/internal/profile-account` rejects plain `graph:read` (S-M1
 * pulse-onboarding: least privilege on the multi-account privacy invariant).
 */
const ARC_RESOLVE_ACCOUNT_SCOPE = "graph:resolve-account";

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
      scope: ARC_RESOLVE_ACCOUNT_SCOPE,
      kid: config.arcKeyId,
    });

    const res = await instrumentedFetch(
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
  // A present-but-INVALID key (corrupt / garbled JWK) must degrade EXACTLY like
  // an absent one — disable the feature (the POST then answers 503), never throw
  // out of the builder. A malformed CIRE_API_ARC_PRIVATE_KEY once made cire-api
  // throw on EVERY authed request and took down the whole organiser dashboard.
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk).catch(() => null);
  if (!arcPrivateKey) return null;
  return createArcAccountResolver({
    osnApiUrl: env.osnApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}

/** Outcome of resolving an OSN handle (e.g. `@alice`) to a profile id. */
export type OsnHandleResolution =
  | { readonly ok: true; readonly profileId: string; readonly handle: string }
  | { readonly ok: false; readonly reason: "profile_not_found" };

/**
 * Resolves an OSN handle (`@alice` / `alice`) to its profile id (`usr_*`).
 * Returns `{ ok: false }` when osn-api reports no such handle; throws on any
 * transport/infra failure so the caller can distinguish "not found" from "osn
 * unavailable". osn-api owns handle normalisation (strips `@`, lowercases) —
 * cire passes the raw handle through.
 */
export type OsnHandleResolver = (handle: string) => Promise<OsnHandleResolution>;

/**
 * Builds an {@link OsnHandleResolver} backed by a real ARC-authenticated call
 * to `GET /graph/internal/profile-by-handle`. Same key + scope as the account
 * resolver (`graph:read`), so a deployment that has the ARC key registered for
 * account-linking automatically gets handle resolution too.
 */
export function createArcHandleResolver(config: ArcResolverConfig): OsnHandleResolver {
  const base = config.osnApiUrl.replace(/\/+$/, "");

  return async (handle) => {
    const token = await signArcToken(config.arcPrivateKey, {
      iss: ARC_ISSUER,
      aud: ARC_AUDIENCE,
      scope: ARC_SCOPE,
      kid: config.arcKeyId,
    });

    const res = await instrumentedFetch(
      `${base}/graph/internal/profile-by-handle?handle=${encodeURIComponent(handle)}`,
      { headers: { authorization: `ARC ${token}` } },
    );

    if (res.status === 404) {
      return { ok: false, reason: "profile_not_found" };
    }
    if (!res.ok) {
      throw new Error(`osn-api GET /graph/internal/profile-by-handle returned ${res.status}`);
    }

    const data = (await res.json()) as { profileId?: unknown; handle?: unknown };
    if (typeof data.profileId !== "string" || data.profileId.length === 0) {
      throw new Error("osn-api profile-by-handle response missing profileId");
    }
    return {
      ok: true,
      profileId: data.profileId,
      handle: typeof data.handle === "string" ? data.handle : handle,
    };
  };
}

/**
 * Builds the handle resolver from raw env material — the sibling of
 * {@link createAccountResolverFromEnv}. Returns `null` when any piece is absent
 * so a deployment without the ARC key simply has co-host-by-handle disabled
 * (the add-host POST then answers 503), never failing to boot.
 */
export async function createHandleResolverFromEnv(env: {
  osnApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<OsnHandleResolver | null> {
  if (!env.osnApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) {
    return null;
  }
  // Present-but-INVALID key ⇒ degrade like absent (co-host-by-handle disabled,
  // add-host POST answers 503) instead of throwing on every request. See the
  // account-resolver builder above for the incident this guards against.
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk).catch(() => null);
  if (!arcPrivateKey) return null;
  return createArcHandleResolver({
    osnApiUrl: env.osnApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}

/** Display metadata for a single OSN profile, surfaced to the organiser portal. */
export interface OsnProfileDisplay {
  readonly handle: string;
  readonly displayName: string | null;
}

/**
 * Batch-resolves a set of OSN profile ids (`usr_*`) to their display metadata
 * (handle + display name). Returns a `Map<profileId, display>` keyed by the id
 * osn-api echoed back; ids osn-api doesn't recognise are simply absent from the
 * map. FAIL-SOFT: any transport/infra failure (osn-api down / 5xx / malformed
 * body) resolves to an EMPTY map, never a throw — the host list then degrades
 * to showing the raw profile id rather than 500ing. This is the deliberate
 * difference from the handle/account resolvers (which throw so the add-host
 * flow can distinguish "not found" from "osn unavailable"): listing hosts must
 * never fail just because the display lookup is unavailable.
 */
export type OsnProfileDisplayResolver = (
  profileIds: readonly string[],
) => Promise<Map<string, OsnProfileDisplay>>;

/**
 * Builds an {@link OsnProfileDisplayResolver} backed by a real ARC-authenticated
 * call to `POST /graph/internal/profile-displays`. Same key + `graph:read` scope
 * as the handle/account resolvers, so a deployment that has the ARC key
 * registered automatically gets host-handle display too.
 */
export function createArcProfileDisplayResolver(
  config: ArcResolverConfig,
): OsnProfileDisplayResolver {
  const base = config.osnApiUrl.replace(/\/+$/, "");

  return async (profileIds) => {
    const empty = new Map<string, OsnProfileDisplay>();
    if (profileIds.length === 0) return empty;

    try {
      const token = await signArcToken(config.arcPrivateKey, {
        iss: ARC_ISSUER,
        aud: ARC_AUDIENCE,
        scope: ARC_SCOPE,
        kid: config.arcKeyId,
      });

      const res = await instrumentedFetch(`${base}/graph/internal/profile-displays`, {
        method: "POST",
        headers: { authorization: `ARC ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ profileIds: [...profileIds] }),
      });

      if (!res.ok) return empty;

      const data = (await res.json()) as {
        profiles?: { id?: unknown; handle?: unknown; displayName?: unknown }[];
      };
      if (!Array.isArray(data.profiles)) return empty;

      const map = new Map<string, OsnProfileDisplay>();
      for (const p of data.profiles) {
        if (typeof p.id !== "string" || typeof p.handle !== "string") continue;
        map.set(p.id, {
          handle: p.handle,
          displayName: typeof p.displayName === "string" ? p.displayName : null,
        });
      }
      return map;
    } catch {
      // FAIL-SOFT: never let a display lookup failure break the host list.
      return empty;
    }
  };
}

/**
 * Builds the profile-display resolver from raw env material — the sibling of
 * {@link createHandleResolverFromEnv}. Returns `null` when any piece is absent
 * so a deployment without the ARC key simply shows profile ids in the host list
 * (the fallback), never failing to boot. A present-but-invalid key degrades the
 * same way (disabled, ids shown) instead of throwing.
 */
export async function createProfileDisplayResolverFromEnv(env: {
  osnApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<OsnProfileDisplayResolver | null> {
  if (!env.osnApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) {
    return null;
  }
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk).catch(() => null);
  if (!arcPrivateKey) return null;
  return createArcProfileDisplayResolver({
    osnApiUrl: env.osnApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}

/** A single autocomplete suggestion surfaced to the organiser portal. */
export interface OsnHandleSuggestion {
  readonly profileId: string;
  readonly handle: string;
  readonly displayName: string | null;
}

/**
 * Suggests OSN profiles whose handle starts with `prefix`, for the add-co-host
 * autocomplete in the organiser portal. Returns the (already capped, ordered)
 * list osn-api produced. FAIL-SOFT: any short/empty prefix or transport/infra
 * failure (osn-api down / 5xx / malformed body / missing ARC key) resolves to an
 * EMPTY list, never a throw — an unavailable autocomplete simply suggests
 * nothing while the manual type-and-submit add path keeps working. This mirrors
 * the profile-display resolver (fail-soft) rather than the handle/account
 * resolvers (which throw to distinguish "not found" from "unavailable").
 */
export type OsnHandleSearchResolver = (prefix: string) => Promise<OsnHandleSuggestion[]>;

/**
 * Builds an {@link OsnHandleSearchResolver} backed by a real ARC-authenticated
 * call to `GET /graph/internal/profile-search`. Same key + `graph:read` scope as
 * the sibling resolvers, so a deployment that has the ARC key registered gets
 * handle autocomplete too. osn-api owns prefix normalisation, the min-length
 * floor, ordering, and the result cap — this just forwards the raw query.
 */
export function createArcHandleSearchResolver(config: ArcResolverConfig): OsnHandleSearchResolver {
  const base = config.osnApiUrl.replace(/\/+$/, "");

  return async (prefix) => {
    const empty: OsnHandleSuggestion[] = [];
    if (prefix.trim().length === 0) return empty;

    try {
      const token = await signArcToken(config.arcPrivateKey, {
        iss: ARC_ISSUER,
        aud: ARC_AUDIENCE,
        scope: ARC_SCOPE,
        kid: config.arcKeyId,
      });

      const res = await instrumentedFetch(
        `${base}/graph/internal/profile-search?prefix=${encodeURIComponent(prefix)}`,
        { headers: { authorization: `ARC ${token}` } },
      );

      if (!res.ok) return empty;

      const data = (await res.json()) as {
        profiles?: { id?: unknown; handle?: unknown; displayName?: unknown }[];
      };
      if (!Array.isArray(data.profiles)) return empty;

      const out: OsnHandleSuggestion[] = [];
      for (const p of data.profiles) {
        if (typeof p.id !== "string" || typeof p.handle !== "string") continue;
        out.push({
          profileId: p.id,
          handle: p.handle,
          displayName: typeof p.displayName === "string" ? p.displayName : null,
        });
      }
      return out;
    } catch {
      // FAIL-SOFT: never let an autocomplete lookup failure break the portal.
      return empty;
    }
  };
}

/**
 * Builds the handle-search resolver from raw env material — the sibling of
 * {@link createProfileDisplayResolverFromEnv}. Returns `null` when any piece is
 * absent so a deployment without the ARC key simply has co-host autocomplete
 * disabled (the search route then returns an empty list), never failing to boot.
 * A present-but-invalid key degrades the same way.
 */
export async function createHandleSearchResolverFromEnv(env: {
  osnApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<OsnHandleSearchResolver | null> {
  if (!env.osnApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) {
    return null;
  }
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk).catch(() => null);
  if (!arcPrivateKey) return null;
  return createArcHandleSearchResolver({
    osnApiUrl: env.osnApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}
