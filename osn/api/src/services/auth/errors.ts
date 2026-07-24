import { Data } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

/**
 * COPPA under-13 registration rejection (C-H8). Distinct from ValidationError
 * so the route layer can map it to HTTP 422 with the fixed public message
 * "OSN is for users 13 and older" rather than a generic 400. See
 * [[compliance/coppa]].
 */
export class AgeRestrictionError extends Data.TaggedError("AgeRestrictionError")<{}> {}

/**
 * The closed set of OAuth 2.0 / OIDC error codes this provider emits. Every
 * one is a wire value defined by RFC 6749 §4.1.2.1 / §5.2 or OIDC Core §3.1.2.6
 * — never invent a code, because relying-party libraries switch on these
 * strings.
 */
export type OidcErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_response_type"
  | "unsupported_grant_type"
  | "access_denied"
  | "login_required"
  | "consent_required"
  | "interaction_required"
  | "server_error";

/**
 * An OIDC protocol failure. Carries the wire code plus a human description.
 *
 * The route layer decides how to deliver it, and the rule is not cosmetic: an
 * error raised BEFORE the client and redirect URI are validated must be
 * rendered to the user, never redirected (RFC 6749 §4.1.2.1). Redirecting an
 * unvalidated URI is an open redirect.
 */
export class OidcError extends Data.TaggedError("OidcError")<{
  readonly code: OidcErrorCode;
  readonly description: string;
}> {}
