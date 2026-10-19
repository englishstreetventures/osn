import { Data } from "effect";

export class SeedInputError extends Data.TaggedError("SeedInputError")<{
  /** Which input was refused, by the name of the secret or value it comes from. Never its content. */
  readonly input: string;
  readonly message: string;
}> {}

/**
 * The unix second every seeded row records. Fixed, so the file is
 * byte-identical across runs and a second deploy re-imports nothing.
 * 2025-10-17T00:00:00Z.
 */
const SEEDED_AT = 1760659200;

/** The sector cire's OIDC client derives pairwise subjects in, on every tier. */
const CIRE_SECTOR = "cireweddings.com"; // not a host: the pairwise sector identifier

/**
 * Every scope cire-api's ARC tokens request of osn-api: the `ARC_*_SCOPE`
 * constants of `cire/api/src/services/osn-bridge.ts`. osn-api refuses a
 * token scope missing from the service account's `allowed_scopes`
 * (`shared/crypto/src/arc.ts`).
 */
const CIRE_API_ARC_SCOPES = [
  "graph:read",
  "graph:resolve-account",
  "org:read",
  "account:email-read",
];

const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
/** One P-256 coordinate: 32 bytes, base64url without padding. */
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

interface JwkFields {
  readonly kty?: unknown;
  readonly crv?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly d?: unknown;
}

const refuseKey = (reason: string): SeedInputError =>
  new SeedInputError({
    input: "CIRE_API_ARC_PUBLIC_JWK",
    message: `CIRE_API_ARC_PUBLIC_JWK ${reason}; it must be the public half of an ES256 JWK (kty EC, crv P-256, with x and y, without d).`,
  });

/**
 * cire-api's ARC public key as osn-api stores it in
 * `service_account_keys.public_key_jwk`: `kty`, `crv`, `x` and `y`, in that
 * order. A key carrying `d` is refused, so a private key never reaches the
 * seed.
 */
function arcPublicKeyColumn(publicJwk: string): string {
  let parsed: JwkFields | null;
  try {
    parsed = JSON.parse(publicJwk) as JwkFields | null;
  } catch {
    // JSON.parse's message can quote the input, so it is never passed on.
    throw refuseKey("is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refuseKey("is not a JSON object");
  }
  const { kty, crv, x, y, d } = parsed;
  if (d !== undefined) throw refuseKey("carries d, the private key");
  if (kty !== "EC" || crv !== "P-256") throw refuseKey("is not an EC P-256 key");
  if (typeof x !== "string" || typeof y !== "string") throw refuseKey("has no x or no y");
  if (!COORDINATE.test(x) || !COORDINATE.test(y)) {
    throw refuseKey("has an x or y that is not a 32-byte base64url value");
  }
  return JSON.stringify({ kty, crv, x, y });
}

/**
 * osn-api's dev database rows that let cire-api sign organisers in and call
 * osn-api, as one SQL file Alchemy imports after the migrations:
 *
 * - the `cid_cire` OIDC client, its redirect URI the one cire-api builds
 *   from `CIRE_API_ORIGIN` (`cire/api/src/index.ts`) and its hash the
 *   SHA-256 of `CIRE_OIDC_CLIENT_SECRET`;
 * - cire-api's ARC service account and key, written as
 *   `POST /graph/internal/register-service` writes them
 *   (`osn/api/src/routes/graph-internal.ts`).
 *
 * It takes the hash and the public key, never the secrets they come from:
 * `scripts/derive-cire-seed.ts` derives them in a step of their own.
 *
 * A re-import never undoes what an operator did in the database: it leaves a
 * disabled client disabled and a revoked or expired key so, and leaves a key
 * id another service holds to that service. Replacing a revoked key takes a
 * new `CIRE_API_ARC_KEY_ID`.
 *
 * Columns and units (unix seconds) are those of `osn/db/src/schema/index.ts`
 * (`oauth_clients`, `service_accounts`, `service_account_keys`). Every value
 * is checked so none can carry a quote, and the file never holds a secret.
 */
export function osnSeedSql(input: {
  readonly cireApiOrigin: string;
  /** `CIRE_OIDC_CLIENT_SECRET_SHA256`: lower-case SHA-256 hex. */
  readonly clientSecretSha256: string;
  readonly arcKeyId: string;
  /** `CIRE_API_ARC_PUBLIC_JWK`: the public half of cire-api's ARC key. */
  readonly arcPublicJwk: string;
}): string {
  if (!ORIGIN.test(input.cireApiOrigin)) {
    throw new SeedInputError({
      input: "cire-api origin",
      message: "The cire-api origin is not https:// followed by a lower-case host.",
    });
  }
  if (!UUID.test(input.arcKeyId)) {
    throw new SeedInputError({
      input: "CIRE_API_ARC_KEY_ID",
      message: "CIRE_API_ARC_KEY_ID is not a UUID.",
    });
  }
  const hash = input.clientSecretSha256;
  if (!HEX.test(hash)) {
    throw new SeedInputError({
      input: "CIRE_OIDC_CLIENT_SECRET_SHA256",
      message: "CIRE_OIDC_CLIENT_SECRET_SHA256 is not lower-case SHA-256 hex.",
    });
  }
  const publicJwk = arcPublicKeyColumn(input.arcPublicJwk);
  const redirectUris = JSON.stringify([`${input.cireApiOrigin}/api/auth/oidc/callback`]);
  const scopes = CIRE_API_ARC_SCOPES.join(",");
  return `-- Generated by musubi/infra on every deploy; Alchemy re-imports it when it changes.
INSERT INTO oauth_clients (id, client_id, name, logo_url, redirect_uris, client_secret_hash, sector_identifier, allowed_scopes, is_first_party, owner_account_id, created_at, disabled_at)
VALUES ('oc_cire', 'cid_cire', 'Cire', NULL, '${redirectUris}', '${hash}', '${CIRE_SECTOR}', 'openid profile email', 1, NULL, ${SEEDED_AT}, NULL)
ON CONFLICT(client_id) DO UPDATE SET redirect_uris = excluded.redirect_uris, client_secret_hash = excluded.client_secret_hash, sector_identifier = excluded.sector_identifier, allowed_scopes = excluded.allowed_scopes, is_first_party = excluded.is_first_party;
INSERT INTO service_accounts (service_id, allowed_scopes, created_at, updated_at)
VALUES ('cire-api', '${scopes}', ${SEEDED_AT}, ${SEEDED_AT})
ON CONFLICT(service_id) DO UPDATE SET allowed_scopes = excluded.allowed_scopes;
INSERT INTO service_account_keys (key_id, service_id, public_key_jwk, registered_at, expires_at, revoked_at)
VALUES ('${input.arcKeyId}', 'cire-api', '${publicJwk}', ${SEEDED_AT}, NULL, NULL)
ON CONFLICT(key_id) DO UPDATE SET public_key_jwk = excluded.public_key_jwk WHERE service_account_keys.service_id = 'cire-api';
`;
}
