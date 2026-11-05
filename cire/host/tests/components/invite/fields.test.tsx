// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { isHiddenState } from "../../../src/components/invite/fields";

describe("isHiddenState", () => {
  it.each([
    [undefined, false],
    ["shown", false],
    ["empty", true],
    ["off", true],
  ] as const)("reads %s as hidden: %s", (state, hidden) => {
    expect(isHiddenState(state)).toBe(hidden);
  });
});
