import { describe, it, expect } from "bun:test";

import { MAX_EVENT_BYTES, readBoundedText } from "../../src/lib/webhook-body";

/** A request whose body arrives in the given chunks, as a real stream. */
function streamed(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  // `duplex` is required by the spec for a streaming request body.
  return new Request("http://localhost/hook", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The three behaviours this function exists for are already exercised end to
 * end through the Stripe webhook route. These pin them at the unit, where the
 * boundary cases are cheap to state and a regression names this function
 * instead of a 400 three layers up.
 */

describe("readBoundedText", () => {
  it("returns the body when it is inside the bound", async () => {
    const req = new Request("http://localhost/hook", { method: "POST", body: '{"id":"evt_1"}' });
    expect(await readBoundedText(req, MAX_EVENT_BYTES)).toBe('{"id":"evt_1"}');
  });

  it("returns an empty string when there is no body at all", async () => {
    const req = new Request("http://localhost/hook", { method: "POST" });
    expect(await readBoundedText(req, MAX_EVENT_BYTES)).toBe("");
  });

  it("gives up past the bound rather than buffering the whole body", async () => {
    // Three chunks, over the bound at the second. Nothing about the request
    // declares its size, which is the case `Content-Length` cannot cover.
    const chunk = utf8("x".repeat(64));
    expect(await readBoundedText(streamed([chunk, chunk, chunk]), 100)).toBeNull();
  });

  it("bounds on BYTES, not UTF-16 code units", async () => {
    // Ten characters, thirty bytes. A `String.length` bound of 20 would admit
    // it; a byte bound of 20 must not. This is the bug that lets a body of
    // non-Latin text pass a limit it is well over.
    const body = utf8("日".repeat(10));
    expect(body.byteLength).toBe(30);
    expect(await readBoundedText(streamed([body]), 20)).toBeNull();
    expect(await readBoundedText(streamed([body]), 40)).toBe("日".repeat(10));
  });

  it("decodes a character split across two chunks as one character", async () => {
    // The signature is over the exact text, so a character decoded as two
    // replacement characters is a 400 for a body the sender signed correctly.
    const bytes = utf8("é");
    expect(bytes.byteLength).toBe(2);
    const text = await readBoundedText(
      streamed([bytes.slice(0, 1), bytes.slice(1)]),
      MAX_EVENT_BYTES,
    );
    expect(text).toBe("é");
    expect(text).not.toContain("�");
  });

  it("admits a body exactly on the bound and refuses one byte past it", async () => {
    expect(await readBoundedText(streamed([utf8("abcd")]), 4)).toBe("abcd");
    expect(await readBoundedText(streamed([utf8("abcde")]), 4)).toBeNull();
  });
});
