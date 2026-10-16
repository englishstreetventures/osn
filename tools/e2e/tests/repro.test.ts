import { describe, expect, test } from "bun:test";

import { firstDifference } from "../src/repro";

describe("firstDifference", () => {
  test("null for identical text", () => {
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeNull();
  });

  test("names the first line that differs", () => {
    expect(firstDifference("a\nb\nc", "a\nB\nc")).toEqual({ line: 2, a: "b", b: "B" });
  });

  test("catches a run that wrote fewer lines", () => {
    expect(firstDifference("a\nb", "a")).toEqual({ line: 2, a: "b", b: "<end>" });
  });
});
