// @vitest-environment happy-dom
/**
 * Where the confirm page follows an app's answer: only to a web address. The
 * page's last guard against an answer it should not follow, so a `javascript:`
 * one runs nothing in Musubi's origin. Read by whoever changes `returnTo`
 * (`src/lib/return-to.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { returnTo } from "../../src/lib/return-to";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("returnTo", () => {
  it("refuses a script, any scheme that is not the web's, and what is not an address", () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    for (const address of [
      "javascript:alert(1)",
      "JavaScript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://host.cireweddings.com/0d2f",
      "not an address",
      "",
    ]) {
      expect(returnTo(address)).toBe(false);
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it("goes to an https or http address, once, as given", () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const address = "https://host.cireweddings.com/#/remove-data?code=x";
    expect(returnTo(address)).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(address);

    expect(returnTo("http://localhost:4322/#/remove-data?code=x")).toBe(true);
    expect(assign).toHaveBeenCalledTimes(2);
  });
});
