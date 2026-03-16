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
