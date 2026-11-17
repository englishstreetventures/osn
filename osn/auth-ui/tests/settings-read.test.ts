import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { ownRead } from "../src/settings-read";

/**
 * The read a view makes for itself when its host hands it none. One failure
 * the views' own tests cannot stage: a read sent before a write, answering
 * after the write's own read, must never put the rows from before the write
 * back on screen.
 */

function heldFetch<T>() {
  const answers: ((value: T) => void)[] = [];
  const fetch = () => new Promise<T>((resolve) => answers.push(resolve));
  return { fetch, answers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ownRead", () => {
  it("never lands a read sent before a write after the write's own read", async () => {
    const { fetch, answers } = heldFetch<string[]>();
    await createRoot(async (dispose) => {
      const read = ownRead(fetch);
      answers[0]!(["before"]);
      await settle();
      expect(read.value()).toEqual(["before"]);

      // A read out (Try again), then a write whose effect only the server knows.
      read.retry();
      read.write()("unknown");
      expect(answers).toHaveLength(3);
      answers[2]!(["after"]);
      await settle();
      expect(read.value()).toEqual(["after"]);
      // The older read answers last, with the rows from before the write.
      answers[1]!(["before"]);
      await settle();
      expect(read.value()).toEqual(["after"]);
      dispose();
    });
  });
});
