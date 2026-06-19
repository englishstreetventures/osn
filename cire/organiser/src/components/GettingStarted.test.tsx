// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GettingStarted fetches a one-off snapshot (events, guests, invite) and derives
 * a four-step checklist whose `done` state reflects the wedding's real data. It
 * jumps to a tab when a step is clicked, and can be dismissed (persisted per
 * wedding in localStorage) and brought back. The OSN auth + api helpers are
 * stubbed; this asserts the derivation (counts → complete/incomplete), the jump,
 * and the dismiss/restore + persistence.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import GettingStarted from "./GettingStarted";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route the three snapshot fetches by URL so order doesn't matter. */
function mockSnapshot(opts: { events: unknown[]; guests: unknown[]; invite: unknown }) {
  authFetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/events")) return Promise.resolve(json(opts.events));
    if (url.endsWith("/guests")) return Promise.resolve(json(opts.guests));
    if (url.endsWith("/invite")) return Promise.resolve(json(opts.invite));
    return Promise.resolve(json({}, 404));
  });
}

const EMPTY_INVITE = {
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { heading: null, body: null, imageUrl: null },
};

/** The checklist's step buttons carry data-complete; the dismiss X doesn't —
 *  filter to the steps so chrome buttons aren't counted. */
function stepButtons() {
  return screen.getAllByRole("button").filter((b) => b.hasAttribute("data-complete"));
}

describe("GettingStarted", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    // Dismissal persists to localStorage per wedding — reset between tests so
    // one test's dismiss doesn't hide the checklist in the next.
    localStorage.clear();
  });

  it("shows 0/4 and all steps incomplete for a brand-new wedding", async () => {
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);

    await waitFor(() => expect(screen.getByText("0 / 4 done")).toBeTruthy());
    // Every step button is pending (data-complete=false).
    const steps = stepButtons();
    expect(steps).toHaveLength(4);
    expect(steps.every((b) => b.getAttribute("data-complete") === "false")).toBe(true);
  });

  it("marks events + guests complete once they exist", async () => {
    mockSnapshot({
      events: [{ id: "e1" }],
      // Two members of one household, only one sent.
      guests: [
        { familyId: "f1", codeSharedAt: 123 },
        { familyId: "f1", codeSharedAt: null },
      ],
      invite: EMPTY_INVITE,
    });
    render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);

    // events ✓, guests ✓, invite ✗ (empty), share ✓ (the one family is sent) ⇒ 3/4.
    await waitFor(() => expect(screen.getByText("3 / 4 done")).toBeTruthy());
  });

  it("counts the invite as customised when a hero title is set", async () => {
    mockSnapshot({
      events: [{ id: "e1" }],
      guests: [{ familyId: "f1", codeSharedAt: 1 }],
      invite: {
        hero: { title: "V & R", subtitle: null, imageUrl: null },
        story: { heading: null, body: null, imageUrl: null },
      },
    });
    render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);

    await waitFor(() => expect(screen.getByText("4 / 4 done")).toBeTruthy());
    expect(screen.getByText(/Everything's ready/i)).toBeTruthy();
  });

  it("jumps to the matching tab when a step is clicked", async () => {
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    const onJump = vi.fn();
    render(() => <GettingStarted weddingId="wed_1" onJump={onJump} />);

    await waitFor(() => expect(screen.getByText("0 / 4 done")).toBeTruthy());
    fireEvent.click(screen.getByText("Add your events"));
    expect(onJump).toHaveBeenCalledWith("events");
  });

  it("dismisses to a 'Show getting started' affordance and restores", async () => {
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);

    await waitFor(() => expect(screen.getByText("0 / 4 done")).toBeTruthy());

    // Dismiss via the X — the checklist collapses to the "Show" link, and the
    // dismissal is persisted for this wedding.
    fireEvent.click(screen.getByRole("button", { name: /Dismiss getting started/i }));
    expect(screen.queryByText("0 / 4 done")).toBeNull();
    expect(screen.getByRole("button", { name: /Show getting started/i })).toBeTruthy();
    expect(localStorage.getItem("cire:getting-started-dismissed:wed_1")).toBe("1");

    // Bring it back — the checklist returns and the persisted flag is cleared.
    fireEvent.click(screen.getByRole("button", { name: /Show getting started/i }));
    expect(screen.getByText("0 / 4 done")).toBeTruthy();
    expect(localStorage.getItem("cire:getting-started-dismissed:wed_1")).toBeNull();
  });

  it("stays dismissed across a reload when localStorage already has the flag", async () => {
    // Simulate a prior dismissal persisted for this wedding.
    localStorage.setItem("cire:getting-started-dismissed:wed_9", "1");
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    render(() => <GettingStarted weddingId="wed_9" onJump={() => {}} />);

    // The checklist never paints; only the restore affordance does (once the
    // snapshot resolves).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Show getting started/i })).toBeTruthy(),
    );
    expect(screen.queryByText("0 / 4 done")).toBeNull();
  });

  it("keeps dismissal per-wedding (dismissing one leaves another visible)", async () => {
    // wed_a dismissed, wed_b not.
    localStorage.setItem("cire:getting-started-dismissed:wed_a", "1");
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    render(() => <GettingStarted weddingId="wed_b" onJump={() => {}} />);

    // wed_b's checklist shows because its own key isn't set.
    await waitFor(() => expect(screen.getByText("0 / 4 done")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Show getting started/i })).toBeNull();
  });
});
