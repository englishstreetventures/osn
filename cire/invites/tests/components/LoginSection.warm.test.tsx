import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A returning household: this browser holds the restore hint, so the page's
 * session restore is about to open the invite without a code. The account link
 * and — when the claim behind the hint showed it — the plus-one prompt start
 * loading at mount, beside that restore request,
 * rather than after it — otherwise they appear late, above events that are
 * already on screen.
 *
 * Its own file, so its module registry starts with nothing loaded: the counts
 * in LoginSection.lazy.test.tsx have already risen by the time a case there
 * could look.
 */
const loads = vi.hoisted(() => ({ pulse: 0, auth: 0, plusOne: 0 }));

vi.mock("../../src/components/PulseAccountLink", () => {
  loads.pulse++;
  return { PulseAccountLink: () => <div data-testid="pulse-account-link-stub" /> };
});

vi.mock("../../src/components/PlusOnePrompt", () => {
  loads.plusOne++;
  return { PlusOnePrompt: () => <div data-testid="plus-one-prompt-stub" /> };
});

vi.mock("@shared/rp-auth/solid", () => {
  loads.auth++;
  return { AuthProvider: (props: { children: unknown }) => props.children };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
});

describe("LoginSection warms the controls for a returning household", () => {
  it("starts loading them at mount when the restore hint says the prompt showed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    document.cookie = "cire_claimed=plus-one; Path=/";
    const { LoginSection } = await import("../../src/components/LoginSection");
    render(() => <LoginSection apiUrl="http://x" result={null} onClaimed={() => {}} />);
    await waitFor(() => expect(loads.pulse).toBe(1));
    await waitFor(() => expect(loads.plusOne).toBe(1));
    // The Solid auth binding is never needed: the restore carries the sign-in.
    expect(loads.auth).toBe(0);
  });
});
