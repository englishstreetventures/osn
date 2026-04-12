import { Data } from "effect";

/** Tagged error for Redis operation failures. */
export class RedisError extends Data.TaggedError("RedisError")<{
  readonly cause: unknown;
}> {}
