/**
 * Reading a webhook body safely, before anything has authenticated it.
 *
 * Shared by both Stripe endpoints — the Connect one that hears about gifts on a
 * couple's connected account, and the platform one that hears about upgrade
 * purchases where cire is the merchant. Each verifies its own deliveries with
 * its own signing secret, but the problem below is identical for both, and it
 * has to be solved before either signature can be checked: the signature is
 * over the body, so the body must be in hand first.
 *
 * NOT `readCappedBytes` (`services/link-preview.ts`), which is deliberately a
 * different thing despite the similar shape: it bounds a `Response` we chose to
 * fetch and returns bytes, where this bounds an inbound `Request` an attacker
 * chose to send and returns a streaming-decoded string.
 */

/**
 * The most a webhook event can be, in bytes.
 *
 * The endpoints are public, unauthenticated and unlimited — the signature IS
 * the authentication, and it cannot run until the body has been read. So the
 * body is what an attacker gets to choose the size of. Rejecting on the
 * declared `content-length` costs one map lookup and happens before a single
 * byte is buffered into isolate memory; the same bound is then enforced *as the
 * body arrives*, because `Content-Length` is theirs to lie about. Stripe's own
 * events run to a few KB.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

/**
 * Read at most `max` BYTES of the body, or give up.
 *
 * Two things the obvious `await request.text()` gets wrong on a public,
 * pre-authentication endpoint:
 *
 *  - **It buffers everything first.** A checked length after the await is a
 *    check on memory already spent: a lying `Content-Length` — or none at all,
 *    which chunked encoding allows — puts the whole body in the isolate before
 *    the bound is consulted. Cloudflare kills a Worker that exceeds its memory
 *    limit, so the failure is the isolate, not a 400.
 *  - **`String.length` is not bytes.** It counts UTF-16 code units, so any
 *    body of non-Latin text passes a byte bound it is over — twice over for
 *    text outside the BMP.
 *
 * So the stream is drained a chunk at a time and abandoned the moment the
 * running byte count passes the bound. Leaving the loop cancels the stream,
 * which is what tells the runtime to stop pulling the rest of the upload.
 *
 * Returns the decoded text, or `null` when the body was too big.
 */
export async function readBoundedText(request: Request, max: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  // Async iteration, not a reader loop: each chunk has to be counted before the
  // next is pulled, so there is nothing here to run concurrently. Leaving the
  // loop early — `return null` on the bound, or a throw — runs the iterator's
  // `return()`, and that cancels the stream, which is what tells the runtime to
  // stop pulling the rest of the upload.
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > max) return null;
    // `stream: true` so a multi-byte character split across two chunks is
    // decoded as one character rather than two replacement ones — the
    // signature is over the exact text, so a mangled decode is a 400 for a
    // body Stripe signed correctly.
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
