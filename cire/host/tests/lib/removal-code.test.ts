// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
/**
 * `takeRemovalCode` touches the removal screen's address and nothing else, and
 * never loses a code it already kept. The screen reads the kept code after a
 * reload, when the address no longer carries it.
 */

import { forgetRemoval, keepCode, keptCode } from "../../src/lib/account-removal";
import { takeRemovalCode } from "../../src/lib/removal-code";

beforeEach(() => forgetRemoval());

afterEach(() => {
  forgetRemoval();
  history.replaceState(null, "", "/");
});

describe("takeRemovalCode", () => {
  it("keeps the code it already holds when the address carries none", () => {
    keepCode("Zx9_kept_code");
    history.replaceState(null, "", "/#/remove-data");

    expect(takeRemovalCode()).toBeUndefined();
    expect(keptCode()).toBe("Zx9_kept_code");
    expect(window.location.hash).toBe("#/remove-data");
  });

  it("leaves another view's address as it is", () => {
    history.replaceState(null, "", "/#/w/wed_1/settings/export?from=menu");

    expect(takeRemovalCode()).toBeUndefined();
    expect(window.location.hash).toBe("#/w/wed_1/settings/export?from=menu");
    expect(keptCode()).toBeNull();
  });
});
