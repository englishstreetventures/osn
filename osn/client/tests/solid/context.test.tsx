import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";

import type { OsnAuthRuntime, SessionChange } from "../../src/runtime";
import { AuthProvider } from "../../src/solid/context";

/**
 * F19, the provider half: an unmounted `AuthProvider` must stop listening, or
 * a later session change would write into a disposed tree.
 */
it("F19: AuthProvider unsubscribes from the runtime when it unmounts", () => {
  const listeners = new Set<(change: SessionChange) => void>();
  const unsubscribe = vi.fn();
  const runtime: OsnAuthRuntime = {
    authFetch: vi.fn(),
    run: vi.fn(() => new Promise<never>(() => {})),
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };

  createRoot((dispose) => {
    AuthProvider({ auth: runtime, children: null });
    expect(listeners.size).toBe(1);
    dispose();
  });

  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});
