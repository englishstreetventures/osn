import { describe, expect, it } from "vitest";

import { replyCloseCode } from "../../src/server/close-reply";

describe("replyCloseCode", () => {
  it.each([1004, 1005, 1006, 1015])("answers the reserved code %i with 1000", (code) => {
    expect(replyCloseCode(code)).toBe(1000);
  });

  it.each([1000, 1001, 1008, 4001])("echoes %i", (code) => {
    expect(replyCloseCode(code)).toBe(code);
  });
});
