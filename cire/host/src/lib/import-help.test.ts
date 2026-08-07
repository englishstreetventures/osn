// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { hasSeenImportHelp, markImportHelpSeen, resetImportHelpSeen } from "./import-help";

afterEach(() => {
  resetImportHelpSeen();
  vi.restoreAllMocks();
});

describe("import-help", () => {
  it("starts unseen, and stays seen once marked", () => {
    expect(hasSeenImportHelp()).toBe(false);
    markImportHelpSeen();
    expect(hasSeenImportHelp()).toBe(true);
  });

  it("shares one bit across both sheets", () => {
    // The events and guests guides have the same shape, so meeting one counts as
    // meeting the other — there is deliberately no per-kind key.
    markImportHelpSeen();
    expect(hasSeenImportHelp()).toBe(true);
    resetImportHelpSeen();
    expect(hasSeenImportHelp()).toBe(false);
  });

  it("reports 'not seen' rather than throwing when storage is unavailable", () => {
    // Private-mode Safari throws on access; the honest fallback is an extra
    // expansion, never a crash that takes the import panel down with it.
    vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(hasSeenImportHelp()).toBe(false);
  });

  it("swallows a failed write", () => {
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => markImportHelpSeen()).not.toThrow();
  });
});
