/**
 * Where the access-token signing keys live, and who must have signed them.
 *
 * The two travel together because neither is sufficient alone: the JWKS says a
 * key is genuine, `iss` says the token came from the deployment we expect
 * rather than any other OSN install sharing the curve. Bundling them means a
 * call site cannot supply one and silently forget the other — the failure mode
 * that kept `iss` unenforced, since an unset expected issuer is not an error,
 * it is simply no check at all.
 */
export interface OsnTokenVerification {
  /** Full JWKS URL of the OSN issuer. */
  readonly jwksUrl: string;
  /** Expected `iss` claim — the issuer's origin, exactly as osn-api mints it. */
  readonly issuer: string;
}

export const DEFAULT_JWKS_URL =
  process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";

/**
 * Must match `AuthConfig.issuerUrl` in the osn-api this verifies against,
 * byte for byte. The default matches osn-api's own local default
 * (`osn/api/src/build-deps.ts`); a deployed environment always sets it.
 */
export const DEFAULT_ISSUER_URL = process.env.OSN_ISSUER_URL ?? "http://localhost:4000";

export const DEFAULT_VERIFICATION: OsnTokenVerification = {
  jwksUrl: DEFAULT_JWKS_URL,
  issuer: DEFAULT_ISSUER_URL,
};
