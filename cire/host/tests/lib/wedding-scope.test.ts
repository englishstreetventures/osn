import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetWeddingScope,
  closeWeddingScope,
  isWeddingClosed,
  openWeddingScope,
} from "../../src/lib/wedding-scope";

beforeEach(() => __resetWeddingScope());

describe("wedding-scope", () => {
  it("counts a wedding nobody has opened or closed as open", () => {
    expect(isWeddingClosed("wed_a")).toBe(false);
  });

  it("closes a wedding until it is opened again", () => {
    closeWeddingScope("wed_a");
    expect(isWeddingClosed("wed_a")).toBe(true);
    openWeddingScope("wed_a");
    expect(isWeddingClosed("wed_a")).toBe(false);
  });

  it("closes one wedding without touching another", () => {
    closeWeddingScope("wed_a");
    expect(isWeddingClosed("wed_b")).toBe(false);
  });
});
