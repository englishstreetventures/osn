import { Context, Effect, Layer } from "effect";

import { StorageError } from "./errors";

export interface StorageService {
  readonly get: (key: string) => Effect.Effect<string | null, StorageError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, StorageError>;
  readonly remove: (key: string) => Effect.Effect<void, StorageError>;
}

export class Storage extends Context.Tag("@osn/client/Storage")<Storage, StorageService>() {}

export const StorageLive = Layer.succeed(Storage, {
  get: (key) =>
    Effect.try({
      try: () => localStorage.getItem(key),
      catch: (cause) => new StorageError({ cause }),
    }),
  set: (key, value) =>
    Effect.try({
      try: () => {
        localStorage.setItem(key, value);
      },
      catch: (cause) => new StorageError({ cause }),
    }),
  remove: (key) =>
    Effect.try({
      try: () => {
        localStorage.removeItem(key);
      },
      catch: (cause) => new StorageError({ cause }),
    }),
});

/**
 * In-memory `Storage` layer: persists nothing past the process, so nothing
 * written through it ever reaches disk. Used on iOS to keep the auth session
 * out of `localStorage` (the app has no other way to persist across a cold
 * start there — see `bootstrapFromCookie`), and in tests for isolation.
 * Each call returns a fresh, independent store.
 */
export function createEphemeralStorage(): Layer.Layer<Storage> {
  const store = new Map<string, string>();
  return Layer.succeed(Storage, {
    get: (key) => Effect.succeed(store.get(key) ?? null),
    set: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        store.delete(key);
      }),
  });
}
