import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import InvitePage from "./InvitePage";
import type { ClaimResult, RsvpSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

vi.mock("./UnlockReveal.motion", () => ({
  unlockRevealSequence: vi.fn(() => Promise.resolve()),
}));

const capturedProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("./RsvpModal", () => ({
  RsvpModal: (props: Record<string, unknown>) => {
    capturedProps.value = props;
    return <div data-testid="rsvp-modal-stub" />;
  },
}));

const claim: ClaimResult = {
  publicId: "SHARMA-JOY-RK97",
  familyName: "Sharma",
  members: [
    {
      guestId: "guest-1",
      firstName: "Priya",
      lastName: "Sharma",
      eventIds: ["event-1"],
    },
  ],
  events: [
    {
      id: "event-1",
      name: "Mehndi",
      date: "2026-09-18",
      location: "Sharma Residence",
      description: "Henna evening",
      startAt: "2026-09-18T16:00:00+10:00",
      endAt: "2026-09-18T22:00:00+10:00",
      timezone: "Australia/Sydney",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
    },
  ],
  rsvps: [{ guestId: "guest-1", eventId: "event-1", status: "attending", dietary: "Vegetarian" }],
};

describe("InvitePage", () => {
  afterEach(() => {
    cleanup();
    capturedProps.value = null;
    vi.restoreAllMocks();
  });

  it("threads existingRsvps, apiUrl, members and onSubmitted into RsvpModal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    // Drive the claim flow
    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), {
      target: { value: "SHARMA-JOY-RK97" },
    });
    fireEvent.click(getByText("Open Invitation"));

    // Wait for the event card "Respond" button
    await waitFor(() => expect(getByText(/Respond/i)).toBeTruthy(), { timeout: 2000 });
    fireEvent.click(getByText(/Respond/i));

    await waitFor(() => expect(capturedProps.value).not.toBeNull());

    const props = capturedProps.value!;
    expect(props.apiUrl).toBe("https://api.test");
    expect(props.members).toEqual(claim.members);
    expect(props.existingRsvps).toEqual(claim.rsvps);
    expect(typeof props.onSubmitted).toBe("function");
    expect(typeof props.onClose).toBe("function");

    // onSubmitted should merge into the claimResult — invoke it and confirm
    // a follow-up open uses the new rsvps as existingRsvps
    const updated: RsvpSummary[] = [
      { guestId: "guest-1", eventId: "event-1", status: "declined", dietary: "" },
    ];
    (props.onSubmitted as (r: RsvpSummary[]) => void)(updated);

    // Re-open the modal (the previous one is still in the tree per the stub but
    // we re-open conceptually via state — fire Respond again is a no-op since
    // it's already open. Instead close + reopen by simulating onClose then click.)
    (props.onClose as () => void)();
    capturedProps.value = null;
    await waitFor(() => expect(getByText(/Respond/i)).toBeTruthy());
    fireEvent.click(getByText(/Respond/i));

    await waitFor(() => expect(capturedProps.value).not.toBeNull());
    expect(capturedProps.value!.existingRsvps).toEqual(updated);
  });
});
