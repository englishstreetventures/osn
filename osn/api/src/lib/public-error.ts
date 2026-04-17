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
  const tag = (() => {
    const seen = new Set<unknown>();
    const queue: unknown[] = [e];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const tag_value = (node as { _tag?: unknown })._tag;
      if (typeof tag_value === "string") return tag_value;
      for (const v of Object.values(node)) queue.push(v);
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
