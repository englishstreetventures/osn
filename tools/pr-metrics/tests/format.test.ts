// The formatters, imported straight from `format.ts` rather than through
// `index.ts`'s re-export.
//
// `render.test.ts` covers the same two functions and would keep passing if
// `format.ts` vanished and the bodies moved back into `index.ts`, because it
// imports them from `../index`. This file pins the thing that actually matters
// about the split: these functions are reachable on their own, from a module a
// browser can load. `browser-safe.test.ts` asserts the file imports nothing;
// this asserts it exports what it is supposed to.

import { expect, test } from "bun:test";

import { compactTokens, humanDuration } from "../format";

test("compactTokens keeps large counts readable", () => {
  expect(compactTokens(66_000_000)).toBe("66.0M");
  expect(compactTokens(1_500)).toBe("1.5K");
  expect(compactTokens(42)).toBe("42");
});

test("compactTokens switches units at the boundaries, not near them", () => {
  expect(compactTokens(999)).toBe("999");
  expect(compactTokens(1_000)).toBe("1.0K");
  expect(compactTokens(999_999)).toBe("1000.0K");
  expect(compactTokens(1_000_000)).toBe("1.0M");
});

test("humanDuration reads in the unit that fits", () => {
  expect(humanDuration(45)).toBe("45s");
  expect(humanDuration(1_200)).toBe("20m");
  expect(humanDuration(7_500)).toBe("2h 5m");
});

test("humanDuration switches units at the boundaries", () => {
  expect(humanDuration(59)).toBe("59s");
  expect(humanDuration(60)).toBe("1m");
  expect(humanDuration(3_599)).toBe("60m");
  expect(humanDuration(3_600)).toBe("1h 0m");
});
