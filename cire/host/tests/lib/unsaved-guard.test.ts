// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardRoute } from "../../src/lib/dashboard-route";
import { confirmNavigation, registerUnsavedGuard } from "../../src/lib/unsaved-guard";

const route = (module: "invite" | "guests", sub: string): DashboardRoute => ({
  view: "weddings",
  weddingId: "wed_1",
  module,
  sub,
});

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

  it("lets a dirty guard keep a move to a route it says it keeps, and asks for the rest", () => {
    const unregister = registerUnsavedGuard(
      () => true,
      (next) => next.module === "invite",
    );
    const confirmSpy = stubConfirm(false);
    expect(confirmNavigation({ next: route("invite", "style") })).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(confirmNavigation({ next: route("guests", "list") })).toBe(false);
    // No route named: it cannot know the move is one it keeps, so it asks.
    expect(confirmNavigation()).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    unregister();
  });

  it("asks with the caller's own words", () => {
    const unregister = registerUnsavedGuard(() => true);
    const confirmSpy = stubConfirm(true);
    expect(confirmNavigation({ message: "Leave the import?" })).toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith("Leave the import?");
    unregister();
  });
});
