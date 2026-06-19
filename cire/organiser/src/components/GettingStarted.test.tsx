// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GettingStarted fetches a one-off snapshot (events, guests, invite) and derives
 * a four-step checklist whose `done` state reflects the wedding's real data. It
 * jumps to a tab when a step is clicked. The OSN auth + api helpers are stubbed;
 * this asserts the derivation (counts → complete/incomplete) and the jump.
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

describe("GettingStarted", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
  });

  it("shows 0/4 and all steps incomplete for a brand-new wedding", async () => {
    mockSnapshot({ events: [], guests: [], invite: EMPTY_INVITE });
    render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);

    await waitFor(() => expect(screen.getByText("0 / 4 done")).toBeTruthy());
    // Every step button is pending (data-complete=false).
    const buttons = screen.getAllByRole("button");
    expect(buttons.every((b) => b.getAttribute("data-complete") === "false")).toBe(true);
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
});
