// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "../../src/components/types";

/**
 * The RSVP sheet and the household member step: Save waits until the
 * household says who is answering, a 409 `member_required` hands the page the
 * step, and each stored reply says who sent it ("Answered by").
 */

vi.mock("motion", () => ({ animate: vi.fn(() => ({ finished: Promise.resolve() })) }));
vi.mock("@shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: null,
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};
const raj: FamilyMember = { ...priya, guestId: "guest-raj", firstName: "Raj" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RsvpModal and the member step", () => {
  it("keeps Save disabled, and says why, until the household says who is answering", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="http://x"
        onClose={() => {}}
        memberRequired
      />
    ));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/Choose who you are/)).toBeTruthy();
  });

  it("hands the page the member step on a 409 member_required", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ error: "member_required" }, { status: 409 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onMemberRequired = vi.fn();
    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="http://x"
        onClose={() => {}}
        onMemberRequired={onMemberRequired}
      />
    ));
    const priyaSet = screen.getByText(/Priya Sharma/).closest("fieldset") as HTMLElement;
    fireEvent.click(within(priyaSet).getByRole("button", { name: "Attending" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onMemberRequired).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toContain("Choose who you are");
  });

  it("shows who answered under each stored reply", () => {
    vi.stubGlobal("fetch", vi.fn());
    const replies: RsvpSummary[] = [
      {
        guestId: "guest-priya",
        eventId: "event-1",
        status: "attending",
        dietary: "",
        submittedBy: { guestId: "guest-raj", firstName: "Raj" },
      },
      {
        guestId: "guest-raj",
        eventId: "event-1",
        status: "declined",
        dietary: "",
        submittedBy: null,
      },
    ];
    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        existingRsvps={replies}
        apiUrl="http://x"
        onClose={() => {}}
      />
    ));
    const priyaSet = screen.getByText(/Priya Sharma/).closest("fieldset") as HTMLElement;
    expect(within(priyaSet).getByText("Answered by Raj")).toBeTruthy();
    const rajSet = screen.getAllByText(/Raj Sharma/)[0]!.closest("fieldset") as HTMLElement;
    expect(within(rajSet).queryByText(/Answered by/)).toBeNull();
  });
});
