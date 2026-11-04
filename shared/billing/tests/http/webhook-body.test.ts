import { describe, expect, it } from "vitest";

import { MAX_EVENT_BYTES, readBoundedText } from "../../src/http/webhook-body";

/** A request whose body arrives in the given chunks, with no declared length. */
function streamed(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/hook", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("readBoundedText", () => {
  it("gives up on a streamed body past the bound", async () => {
    const chunk = new Uint8Array(16 * 1024);
    expect(
      await readBoundedText(streamed([chunk, chunk, chunk, chunk, chunk]), MAX_EVENT_BYTES),
    ).toBe(null);
  });

  it("reads a body of exactly the bound whole, and refuses one byte more", async () => {
    const exact = new Uint8Array(MAX_EVENT_BYTES).fill(0x61);
    const over = new Uint8Array(MAX_EVENT_BYTES + 1).fill(0x61);
    expect((await readBoundedText(streamed([exact]), MAX_EVENT_BYTES))?.length).toBe(
      MAX_EVENT_BYTES,
    );
    expect(await readBoundedText(streamed([over]), MAX_EVENT_BYTES)).toBe(null);
  });

  it("bounds on bytes, not UTF-16 code units", async () => {
    // 40 three-byte characters: 40 code units, 120 bytes.
    const text = "€".repeat(40);
    expect(text.length).toBeLessThan(100);
    expect(await readBoundedText(streamed([utf8(text)]), 100)).toBe(null);
  });

  it("decodes a character split across two chunks as one character", async () => {
    const bytes = utf8('{"name":"€"}');
    const split = bytes.indexOf(0xe2) + 1;
    expect(await readBoundedText(streamed([bytes.slice(0, split), bytes.slice(split)]), 100)).toBe(
      '{"name":"€"}',
    );
  });
});
