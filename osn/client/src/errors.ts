import { Data } from "effect";

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly cause: unknown;
}> {}

export class TokenExchangeError extends Data.TaggedError("TokenExchangeError")<{
  readonly cause: unknown;
}> {}

export class TokenRefreshError extends Data.TaggedError("TokenRefreshError")<{
  readonly cause: unknown;
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
}> {}

export class StateMismatchError extends Data.TaggedError("StateMismatchError")<{
  readonly expected: string;
  readonly received: string;
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
