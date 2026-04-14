import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("../../src/lib/rsvps", () => ({
  fetchRsvpsByStatus: (...args: unknown[]) => mockFetch(...args),
}));

import { RsvpModal } from "../../src/components/RsvpModal";

const baseEvent = {
  id: "evt_1",
  guestListVisibility: "public" as const,
  allowInterested: true,
  joinPolicy: "open" as const,
  createdByProfileId: "usr_alice",
};

describe("RsvpModal", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    mockFetch.mockReset();
  });

  it("renders the Going tab by default and fetches its rsvps on open", async () => {
    render(() => <RsvpModal event={baseEvent} accessToken="tok" onClose={() => {}} />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("evt_1", "going", "tok");
    });
  });

  it("includes Maybe / Not going / Going tabs but omits Invited for open events", () => {
    render(() => <RsvpModal event={baseEvent} accessToken={null} onClose={() => {}} />);
    // Kobalte Dialog portals content — use screen to search the whole document.
    expect(screen.queryByText("Going")).toBeTruthy();
    expect(screen.queryByText("Maybe")).toBeTruthy();
    expect(screen.queryByText("Not going")).toBeTruthy();
    expect(screen.queryByText("Invited")).toBeNull();
  });

  it("shows the Invited tab on guest_list events", () => {
    render(() => (
      <RsvpModal
        event={{ ...baseEvent, joinPolicy: "guest_list" }}
        accessToken={null}
        onClose={() => {}}
      />
    ));
    expect(screen.queryByText("Invited")).toBeTruthy();
  });

  it("hides the Maybe tab when allowInterested is false", () => {
    render(() => (
      <RsvpModal
        event={{ ...baseEvent, allowInterested: false }}
        accessToken={null}
        onClose={() => {}}
      />
    ));
    expect(screen.queryByText("Maybe")).toBeNull();
  });

  it("re-fetches when the user switches tabs", async () => {
    render(() => <RsvpModal event={baseEvent} accessToken="tok" onClose={() => {}} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("evt_1", "going", "tok"));
    fireEvent.click(screen.getByText("Not going"));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("evt_1", "not_going", "tok");
    });
  });

  it("renders attendee names from the fetch result", async () => {
    mockFetch.mockResolvedValueOnce([
      {
        id: "rsvp_1",
        eventId: "evt_1",
        profileId: "usr_bob",
        status: "going",
        invitedByProfileId: null,
        isCloseFriend: false,
        createdAt: "2030-01-01T00:00:00Z",
        profile: { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
      },
    ]);
    render(() => <RsvpModal event={baseEvent} accessToken="tok" onClose={() => {}} />);
    expect(await screen.findByText("Bob Smith")).toBeTruthy();
    expect(await screen.findByText("@bob")).toBeTruthy();
  });

  it("shows the locked state for private guest lists when viewer isn't organiser", () => {
    render(() => (
      <RsvpModal
        event={{ ...baseEvent, guestListVisibility: "private" }}
        accessToken="tok"
        currentProfileId="usr_dan"
        onClose={() => {}}
      />
    ));
    expect(screen.queryByText("This event's guest list is private.")).toBeTruthy();
    expect(screen.queryByText("Only the organiser can see who's attending.")).toBeTruthy();
  });

  it("does NOT show the locked state when viewer is the organiser", async () => {
    render(() => (
      <RsvpModal
        event={{ ...baseEvent, guestListVisibility: "private" }}
        accessToken="tok"
        currentProfileId="usr_alice"
        onClose={() => {}}
      />
    ));
    expect(screen.queryByText("This event's guest list is private.")).toBeNull();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(() => <RsvpModal event={baseEvent} accessToken={null} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the dialog is dismissed via Escape", () => {
    const onClose = vi.fn();
    render(() => <RsvpModal event={baseEvent} accessToken={null} onClose={onClose} />);
    // Kobalte Dialog handles Escape natively to dismiss the dialog.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
