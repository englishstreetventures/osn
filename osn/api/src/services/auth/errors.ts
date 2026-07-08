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
