// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissRecoveryPrompt,
  isRecoveryPromptDismissed,
} from "../../src/lib/recovery-codes-prompt";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("recovery-codes prompt dismissal", () => {
  it("starts undismissed", () => {
    expect(isRecoveryPromptDismissed("prof_1")).toBe(false);
  });

  it("remembers a dismissal across a fresh read", () => {
    dismissRecoveryPrompt("prof_1");
    expect(isRecoveryPromptDismissed("prof_1")).toBe(true);
  });

  it("scopes the decision to one profile", () => {
    // The point of the key: a shared device must not hide the prompt from the
    // next person to sign in on it.
    dismissRecoveryPrompt("prof_1");
    expect(isRecoveryPromptDismissed("prof_2")).toBe(false);
  });

  it("keeps no identifier beyond the profile id in the key", () => {
    dismissRecoveryPrompt("prof_1");
    expect(Object.keys(localStorage)).toEqual(["musubi:recovery-codes-prompt-dismissed:prof_1"]);
  });

  it("treats a missing profile id as nothing to remember", () => {
    dismissRecoveryPrompt(null);
    expect(localStorage.length).toBe(0);
    expect(isRecoveryPromptDismissed(null)).toBe(false);
  });

  it("survives storage that throws", () => {
    // A private window throws on access rather than returning null. Asking
    // again is the right answer; crashing a banner is not.
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => dismissRecoveryPrompt("prof_1")).not.toThrow();
    expect(isRecoveryPromptDismissed("prof_1")).toBe(false);
  });
});
