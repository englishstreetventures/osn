import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A returning household whose claim did not show the plus-one prompt: the
 * restore hint holds the plain value. The account link still warms at mount,
 * but the prompt's chunk does not — most households are never offered a
 * plus-one, and would otherwise download it on every visit.
 *
 * Its own file, so its module registry starts with nothing loaded (see
 * LoginSection.warm.test.tsx).
 */
const loads = vi.hoisted(() => ({ pulse: 0, plusOne: 0 }));

vi.mock("../../src/components/PulseAccountLink", () => {
  loads.pulse++;
  return { PulseAccountLink: () => <div data-testid="pulse-account-link-stub" /> };
});

vi.mock("../../src/components/PlusOnePrompt", () => {
  loads.plusOne++;
  return { PlusOnePrompt: () => <div data-testid="plus-one-prompt-stub" /> };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
});

describe("LoginSection on a restore without a plus-one", () => {
  it("warms the account link but not the plus-one prompt", async () => {
    vi.stubGlobal("fetch", vi.fn());
    document.cookie = "cire_claimed=1; Path=/";
    const { LoginSection } = await import("../../src/components/LoginSection");
    render(() => <LoginSection apiUrl="http://x" result={null} onClaimed={() => {}} />);
    await waitFor(() => expect(loads.pulse).toBe(1));
    // Give a wrongly started download the same chance to land.
    await new Promise((r) => setTimeout(r, 20));
    expect(loads.plusOne).toBe(0);
  });
});
