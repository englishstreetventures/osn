import { Context, Data, Effect } from "effect";

// Local R2 surface — narrow to the methods we touch. The Cloudflare Workers
// `R2Bucket` type satisfies this structurally; the in-memory stub used in
// tests implements just these three methods.
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<unknown> | unknown;
  get(
    key: string,
  ): Promise<{ text(): Promise<string> } | null> | { text(): Promise<string> } | null;
  delete(key: string): Promise<unknown> | unknown;
}

export class R2Service extends Context.Tag("R2Service")<R2Service, R2Bucket>() {}

export class R2Error extends Data.TaggedError("R2Error")<{
  readonly reason: string;
  readonly key?: string;
  readonly cause?: unknown;
}> {}

function eventsKey(importId: string): string {
  return `imports/${importId}/events.csv`;
}

function guestsKey(importId: string): string {
  return `imports/${importId}/guests.csv`;
}

export function storeUpload(
  eventsCsv: string,
  guestsCsv: string,
  importId: string,
): Effect.Effect<{ eventsKey: string; guestsKey: string }, R2Error, R2Service> {
  return Effect.gen(function* () {
    const r2 = yield* R2Service;
    const ek = eventsKey(importId);
    const gk = guestsKey(importId);

    yield* Effect.tryPromise({
      try: async () => {
        await Promise.resolve(r2.put(ek, eventsCsv));
        await Promise.resolve(r2.put(gk, guestsCsv));
      },
      catch: (cause) => new R2Error({ reason: "store failed", cause }),
    });

    return { eventsKey: ek, guestsKey: gk };
  });
}

export function fetchUpload(key: string): Effect.Effect<string, R2Error, R2Service> {
  return Effect.gen(function* () {
    const r2 = yield* R2Service;
    const result = yield* Effect.tryPromise({
      try: async () => {
        const obj = await Promise.resolve(r2.get(key));
        if (!obj) return null;
        return await obj.text();
      },
      catch: (cause) => new R2Error({ reason: "fetch failed", key, cause }),
    });

    if (result === null) {
      return yield* Effect.fail(new R2Error({ reason: "key not found", key }));
    }
    return result;
  });
}

// ── Test stub ─────────────────────────────────────────────────────────────────

/**
 * In-memory R2Bucket implementation suitable for unit tests. Mirrors the
 * minimal surface used by `storeUpload` / `fetchUpload`.
 */
export function createR2Stub(): R2Bucket & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      const text =
        typeof value === "string"
          ? value
          : new TextDecoder().decode(value as ArrayBuffer | ArrayBufferView);
      store.set(key, text);
      return Promise.resolve();
    },
    get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: () => Promise.resolve(v) };
    },
    delete(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}
