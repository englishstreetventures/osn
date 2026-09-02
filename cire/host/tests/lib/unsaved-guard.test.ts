// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmNavigation, registerUnsavedGuard } from "../../src/lib/unsaved-guard";

// happy-dom ships no window.confirm — stub it per test.
function stubConfirm(answer: boolean) {
  const confirmSpy = vi.fn().mockReturnValue(answer);
  vi.stubGlobal("confirm", confirmSpy);
  return confirmSpy;
}

describe("unsaved-guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows navigation with no guard registered", () => {
    const confirmSpy = stubConfirm(false);
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("allows navigation without prompting when the guard reports clean", () => {
    const unregister = registerUnsavedGuard(() => false);
    const confirmSpy = stubConfirm(false);
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    unregister();
  });

  it("prompts when dirty and honours the answer", () => {
    const unregister = registerUnsavedGuard(() => true);
    const confirmSpy = stubConfirm(false);
    expect(confirmNavigation()).toBe(false);
    confirmSpy.mockReturnValue(true);
    expect(confirmNavigation()).toBe(true);
    unregister();
  });

  it("unregistering removes the veto (an unmounted form can never block)", () => {
    const unregister = registerUnsavedGuard(() => true);
    unregister();
    const confirmSpy = stubConfirm(false);
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
