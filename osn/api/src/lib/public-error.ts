import { Effect, Layer } from "effect";

/** The wire shape every route error collapses to: a status plus an opaque body. */
export interface PublicErrorResponse {
  status: number;
  body: { error: string; message?: string };
}

/**
 * Maps a thrown Effect-tagged error (or anything else) to a stable, public,
 * non-leaky error payload. The full cause is logged server-side for diagnosis,
 * but only opaque codes / sanitised messages cross the wire (S-H5 / S-M6).
 *
 * Nothing here ever forwards `e.message`: every arm returns a fixed code and,
 * at most, a fixed public string. So unlike `makeSafeError` this function is
 * free to keep looking for a tag inside a defect — finding one refines the
 * STATUS (a died `DatabaseError` is a 500 `internal_error`, not a 400) and
 * names the tag in the server-side log, without putting anything the defect
 * carried on the wire.
 */
export function publicError(
  e: unknown,
  loggerLayer: Layer.Layer<never> = Layer.empty,
): PublicErrorResponse {
  // Effect's own Cause reason nodes carry `_tag`s ("Fail", "Die", …) that
  // would otherwise shadow the domain error's tag — skip them and keep
  // descending into `.error` / `.defect` / children.
  const CAUSE_TAGS = new Set(["Fail", "Die", "Interrupt", "Sequential", "Parallel", "Empty"]);
  const tag = (() => {
    const seen = new Set<unknown>();
    const queue: object[] = e && typeof e === "object" ? [e] : [];
    // P-I1: bound the traversal. A tagged error's `_tag` sits within a few hops
    // of the root, so a small budget never truncates a real lookup. Under the
    // v4 runner (`makeAppRunner`) there are exactly two shapes to reach:
    //   - a TYPED failure, which arrives as the tagged error itself — a hit on
    //     the root, no walking at all. (v3's `FiberFailure` wrapper, and the
    //     hop through its `Cause` to a `Fail` node, are both gone.)
    //   - a DEFECT, which arrives as an `OpaqueDefect`: `.cause` → `Cause` →
    //     `.reasons[0]` (`Die`) → `.defect` → the tagged error. Five hops.
    // The budget guarantees constant worst-case work on the hot error path
    // when an UNtagged value (which falls through to the generic default)
    // references a large object graph (DB layer, fiber state) via a defect.
    let budget = 512;
    let head = 0;
    while (head < queue.length && budget-- > 0) {
      const node = queue[head++];
      if (seen.has(node)) continue;
      seen.add(node);
      const tag_value = (node as { _tag?: unknown })._tag;
      if (typeof tag_value === "string" && !CAUSE_TAGS.has(tag_value)) return tag_value;
      // Traverse ALL own keys — non-enumerable and symbol ones included, which
      // is what `Object.values` cannot do. The load-bearing case is now
      // `Error.cause`: the `new Error(msg, { cause })` form `OpaqueDefect` uses
      // defines `cause` NON-enumerable, so an enumerable-only walk would never
      // reach the retained `Cause` and every defect would fall through to the
      // default. (v4 keys its `Cause`/`Reason` brands by string, so the symbol
      // case is no longer the reason — but arbitrary thrown values may still
      // hide a tag behind one, and covering it is free.)
      for (const key of Reflect.ownKeys(node)) {
        // Plain property read via computed destructuring: one [[Get]], no
        // descriptor allocation. An accessor still runs bound to `node`
        // (exactly as the old `descriptor.get?.call(node)` did), and the try
        // still guards against a throwing getter. `node`'s own key set is
        // genuinely unknowable ahead of time (arbitrary thrown values), so
        // `as never` — not `as any` — lets the computed key through without
        // asserting a shape we don't have.
        let v: unknown;
        try {
          ({ [key]: v } = node as never);
        } catch {
          continue; // a throwing getter is not a tag carrier
        }
        if (v && typeof v === "object") queue.push(v);
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
