import { Effect, Layer, ManagedRuntime } from "effect";

import { AuthFetchTransportError } from "./errors";
import { OsnAuth, createOsnAuthLive, type OsnAuthConfig } from "./service";
import { StorageLive, type Storage } from "./storage";

/**
 * `fetch` that sends the signed-in account's access token and renews it.
 *
 * It resolves with every response, whatever its status, except that a 401 is
 * renewed and retried once. It rejects with exactly one of:
 *
 * - `AuthExpiredError` — the session has ended; `onSessionChange` listeners
 *   were told.
 * - whatever `fetch` rejected with (`TypeError`, `AbortError`) — the request
 *   itself failed or was aborted; the session is kept. A URL that is not on
 *   the issuer's origin is refused the same way, with a `TypeError`, before
 *   anything is sent: the token goes nowhere else.
 * - `TokenRefreshError` — the token had expired and the issuer could not
 *   renew it or could not say why; the session is kept. A token not yet
 *   expired is sent instead. After such a failure renewal pauses, 2 s
 *   doubling to 30 s or the issuer's `Retry-After`, and the calls in the
 *   pause send no grant.
 * - `ActiveProfileResetError` — the account no longer owns the active profile
 *   and the default profile is active now; the request was not sent.
 * - `StorageError`.
 *
 * Every authenticated client in this package is built with one. A client
 * passes its own `credentials`; the default is `"include"`.
 */
export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the runtime tells its listeners after it changed the session itself. */
export type SessionChange =
  | { readonly kind: "ended" }
  | { readonly kind: "profile-reset"; readonly profileId: string };

export interface OsnAuthRuntime {
  /** Every authenticated client is built with this. Clients never see a token. */
  readonly authFetch: AuthFetch;
  /** Runs one operation on this runtime's single `OsnAuth` service. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, OsnAuth>) => Promise<A>;
  /** Called after the runtime ends the session or resets the active profile. Returns an unsubscribe. */
  readonly onSessionChange: (listener: (change: SessionChange) => void) => () => void;
}

/**
 * The page's one auth service. Build it once, at module scope, and hand the
 * same runtime to `AuthProvider` and to every client: the session cache and
 * every single-flight guard live in the service, so a second runtime is a
 * second set of guards and a second `/token` grant racing the first.
 *
 * Builds nothing until its first call, so importing it costs no request.
 *
 * `storage` defaults to `StorageLive` (`localStorage`). A platform where
 * `localStorage` must never hold auth data (iOS) passes another layer, such as
 * `createEphemeralStorage()`.
 */
export function createOsnAuthRuntime(
  config: OsnAuthConfig,
  options?: { storage?: Layer.Layer<Storage> },
): OsnAuthRuntime {
  const listeners = new Set<(change: SessionChange) => void>();
  const onSessionChange = (change: SessionChange) => {
    for (const listener of listeners) {
      // A listener's fault is its own: report it on its own task, after every
      // other listener has heard the change.
      try {
        listener(change);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  };

  const runtime = ManagedRuntime.make(
    createOsnAuthLive(config, { onSessionChange }).pipe(
      Layer.provide(options?.storage ?? StorageLive),
    ),
  );

  const run = <A, E>(effect: Effect.Effect<A, E, OsnAuth>): Promise<A> =>
    runtime.runPromise(effect);

  const authFetch: AuthFetch = (input, init) =>
    run(Effect.flatMap(OsnAuth, (auth) => auth.authFetch(input, init))).catch((err: unknown) => {
      throw err instanceof AuthFetchTransportError ? err.cause : err;
    });

  return {
    authFetch,
    run,
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
