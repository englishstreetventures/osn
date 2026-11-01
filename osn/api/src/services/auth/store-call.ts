import { Effect } from "effect";

import type { CoordinationStoreName } from "../../lib/coordination/names";
import { CoordinationError } from "./errors";

/**
 * Runs one coordination-store call as an Effect. A rejection becomes a typed
 * {@link CoordinationError} naming the store and the operation, which the
 * route answers with a 503 — never a defect, and never a guess at what the
 * store would have said.
 *
 * Nothing is logged here: the store reports every failed call through its own
 * error hook, once.
 */
export const storeCall = <A>(
  store: { readonly namespace: CoordinationStoreName },
  op: string,
  run: () => Promise<A>,
): Effect.Effect<A, CoordinationError> =>
  Effect.tryPromise({
    try: run,
    catch: () => new CoordinationError({ store: store.namespace, op }),
  });
