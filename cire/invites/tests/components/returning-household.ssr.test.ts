import { afterEach, describe, expect, it, vi } from "vitest";

import {
  returningHousehold,
  setReturningHousehold,
} from "../../src/components/returning-household";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("returningHousehold, in the Worker", () => {
  it("ignores a write, so one request's household can never reach another's HTML", () => {
    // A module-scope value on the server lives as long as the isolate and is
    // shared by every request it serves.
    expect(typeof window).toBe("undefined");
    setReturningHousehold(true);
    expect(returningHousehold()).toBe(false);
  });
});
