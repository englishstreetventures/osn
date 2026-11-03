/**
 * Reading a webhook body safely, before anything has authenticated it.
 *
 * The signature is over the body, so the body must be in hand before it can be
 * checked, and until then its size is whatever the sender chose.
 */

/**
 * The most a webhook event can be, in bytes.
 *
 * The endpoint is public and unauthenticated: the signature IS the
 * authentication, and it cannot run until the body has been read. Rejecting on
 * the declared `content-length` costs one header read and happens before a byte
 * is buffered; the same bound is then enforced as the body arrives, because
 * `Content-Length` is the sender's to lie about. Stripe's events run to a few KB.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

/**
 * Read at most `max` BYTES of the body, or give up. Returns the decoded text, or
 * `null` when the body was too big.
 *
 * Two things `await request.text()` gets wrong on a public endpoint:
 *
 *  - **It buffers everything first.** A length checked after the await is a
 *    check on memory already spent; Cloudflare kills a Worker over its memory
 *    limit, so the failure would be the isolate, not a 400.
 *  - **`String.length` is not bytes.** It counts UTF-16 code units, so
 *    non-Latin text passes a byte bound it is over.
 *
 * So the stream is drained a chunk at a time and abandoned the moment the
 * running byte count passes the bound. Leaving the loop early runs the
 * iterator's `return()`, which cancels the stream.
 */
export async function readBoundedText(request: Request, max: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  // Each chunk is counted before the next is pulled, so there is nothing here
  // to run concurrently.
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > max) return null;
    // `stream: true` so a multi-byte character split across two chunks decodes
    // as one character: the signature is over the exact text.
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
