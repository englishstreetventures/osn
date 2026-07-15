import { Context, Data, Effect } from "effect";

// Local R2 surface — narrow to the methods we touch. The Cloudflare Workers
// `R2Bucket` type satisfies this structurally; the in-memory stub used in
// tests implements just these three methods.
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<unknown> | unknown;
  get(
    key: string,
  ): Promise<{ text(): Promise<string> } | null> | { text(): Promise<string> } | null;
  // Cloudflare R2 accepts a single key or an array (multi-key delete); the
  // shared reaper (`r2-cleanup.ts`) prefers the array form and falls back.
  delete(keys: string | string[]): Promise<unknown> | unknown;
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

// Before-image snapshot keys (guest+event editor E3, [[guest-event-editor]] §4):
// the wedding's current-state CSVs captured at apply time, before the change
// mutates anything. Kept under a distinct `before/` prefix so they never collide
// with the uploaded/derived after-sheets and so a bucket listing can tell them
// apart.
function beforeEventsKey(importId: string): string {
  return `imports/${importId}/before/events.csv`;
}

function beforeGuestsKey(importId: string): string {
  return `imports/${importId}/before/guests.csv`;
}

/**
 * Store a change's before-image — the wedding's current-state snapshot CSVs,
 * serialised at full fidelity by `state-export.ts` — under the `before/` prefix
 * for `importId`. Returns the two keys to record on the change row
 * (`beforeEventsR2Key` / `beforeGuestsR2Key`). See [[guest-event-editor]] §4.
 */
export function storeBeforeImage(
  eventsCsv: string,
  guestsCsv: string,
  importId: string,
): Effect.Effect<{ eventsKey: string; guestsKey: string }, R2Error, R2Service> {
  return Effect.gen(function* () {
    const r2 = yield* R2Service;
    const ek = beforeEventsKey(importId);
    const gk = beforeGuestsKey(importId);

    yield* Effect.tryPromise({
      try: async () => {
        await Promise.resolve(r2.put(ek, eventsCsv));
        await Promise.resolve(r2.put(gk, guestsCsv));
      },
      catch: (cause) => new R2Error({ reason: "before-image store failed", cause }),
    });

    return { eventsKey: ek, guestsKey: gk };
  });
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
    // Accept BOTH the single-key and the array (multi-key) delete form, so the
    // stub matches Cloudflare R2 (which the shared best-effort reaper prefers)
    // as well as a single-key binding.
    delete(key: string | string[]) {
      if (Array.isArray(key)) for (const k of key) store.delete(k);
      else store.delete(key);
      return Promise.resolve();
    },
  };
}
