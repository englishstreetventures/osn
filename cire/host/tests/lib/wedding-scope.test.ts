import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetWeddingScope,
  closeWeddingScope,
  isWeddingClosed,
} from "../../src/lib/wedding-scope";

beforeEach(() => __resetWeddingScope());

describe("wedding-scope", () => {
  it("closes one wedding without touching another", () => {
    closeWeddingScope("wed_a");
    expect(isWeddingClosed("wed_b")).toBe(false);
  });
});
