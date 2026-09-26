import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A returning household: this browser holds the restore hint, so the page's
 * session restore is about to open the invite without a code. The account link
 * starts loading at mount, beside that restore request, rather than after it —
 * otherwise it appears late, above events that are already on screen.
 *
 * Its own file, so its module registry starts with nothing loaded: the counts
 * in LoginSection.lazy.test.tsx have already risen by the time a case there
 * could look.
 */
const loads = vi.hoisted(() => ({ pulse: 0, auth: 0 }));

vi.mock("../../src/components/PulseAccountLink", () => {
  loads.pulse++;
  return { PulseAccountLink: () => <div data-testid="pulse-account-link-stub" /> };
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

describe("LoginSection warms the account link for a returning household", () => {
  it("starts loading it at mount when this browser holds the restore hint", async () => {
    vi.stubGlobal("fetch", vi.fn());
    document.cookie = "cire_claimed=1; Path=/";
    const { LoginSection } = await import("../../src/components/LoginSection");
    render(() => <LoginSection apiUrl="http://x" result={null} onClaimed={() => {}} />);
    await waitFor(() => expect(loads).toEqual({ pulse: 1, auth: 1 }));
  });
});
