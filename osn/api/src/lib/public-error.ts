import { Effect, Layer } from "effect";

/**
 * Maps a thrown Effect-tagged error (or anything else) to a stable, public,
 * non-leaky error payload. The full cause is logged server-side for diagnosis,
 * but only opaque codes / sanitised messages cross the wire (S-H5 / S-M6).
 */
export function publicError(
  e: unknown,
  loggerLayer: Layer.Layer<never> = Layer.empty,
): { status: number; body: { error: string; message?: string } } {
  // Effect's own Cause nodes carry `_tag`s ("Fail", "Die", …) that would
  // otherwise shadow the domain error's tag — skip them and keep descending
  // into `.error` / children.
  const CAUSE_TAGS = new Set(["Fail", "Die", "Interrupt", "Sequential", "Parallel", "Empty"]);
  const tag = (() => {
    const seen = new Set<unknown>();
    const queue: unknown[] = [e];
    // P-I1: bound the traversal. A tagged error's `_tag` sits within a few hops
    // of the root (the instance itself, or a FiberFailure → Cause → Fail node),
    // so a small budget never truncates a real lookup — but it guarantees
    // constant worst-case work on the hot error path when an UNtagged value
    // (which falls through to the generic default) references a large object
    // graph (DB layer, fiber state) via a `Die` cause.
    let budget = 512;
    while (queue.length && budget-- > 0) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const tag_value = (node as { _tag?: unknown })._tag;
      if (typeof tag_value === "string" && !CAUSE_TAGS.has(tag_value)) return tag_value;
      // Traverse ALL own keys (string + symbol), not just enumerable values:
      // `Effect.runPromise` rejects with a `FiberFailure` that stores the
      // underlying tagged error under a symbol-keyed `Cause`, which
      // `Object.values` never reaches — so the real `_tag` would otherwise be
      // invisible and every Effect failure would fall through to the default.
      for (const key of Reflect.ownKeys(node)) {
        let v: unknown;
        try {
          v = (node as Record<PropertyKey, unknown>)[key];
        } catch {
          continue; // a throwing getter is not a tag carrier
        }
        queue.push(v);
      }
    }
    return null;
  })();

  void Effect.runPromise(
    Effect.logError("route error").pipe(
      Effect.annotateLogs({ tag: tag ?? "unknown" }),
      Effect.provide(loggerLayer),
    ),
  );

  switch (tag) {
    // C-H8 (COPPA): fixed-shape 422 with the generic public message. Never
    // reveals whether the email/handle was otherwise valid or taken.
    case "AgeRestrictionError":
      return {
        status: 422,
        body: { error: "age_restricted", message: "OSN is for users 13 and older" },
      };
    case "ValidationError":
      return { status: 400, body: { error: "invalid_request" } };
    case "AuthError":
      return { status: 400, body: { error: "invalid_request" } };
    case "DatabaseError":
      return { status: 500, body: { error: "internal_error" } };
    default:
      return { status: 400, body: { error: "invalid_request" } };
  }
}
