import { Data } from "effect";

export class TokenRefreshError extends Data.TaggedError("TokenRefreshError")<{
  readonly cause: unknown;
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
}> {}

export class ProfileManagementError extends Data.TaggedError("ProfileManagementError")<{
  readonly cause: unknown;
}> {}

/**
 * Surfaced from `authFetch` when the access token is expired AND a silent
 * refresh cycle has failed. Callers should redirect the user to sign in.
 */
export class AuthExpiredError extends Data.TaggedError("AuthExpiredError")<{
  readonly cause?: unknown;
}> {}
