/**
 * A request body that streams `count` copies of `chunk`, then `tail` if given,
 * and declares no length, as a chunked upload does. `seen` records how many
 * chunks the reader pulled and whether it cancelled the rest: a route that
 * bounds its read stops a chunk or two past its bound and cancels, while one
 * that buffers the whole body pulls every chunk and never cancels.
 */
export function countedStream(chunk: Uint8Array, count: number, tail?: Uint8Array) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled < count) {
        seen.pulled += 1;
        controller.enqueue(chunk);
        return;
      }
      if (tail && seen.pulled === count) {
        seen.pulled += 1;
        controller.enqueue(tail);
        return;
      }
      controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

/** `RequestInit` for a streamed body; the spec requires `duplex: "half"`. */
export function streamedInit(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): RequestInit {
  return { method: "POST", headers, body, duplex: "half" } as RequestInit & { duplex: "half" };
}
