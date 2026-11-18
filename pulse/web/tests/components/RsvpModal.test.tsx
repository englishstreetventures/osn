import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
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

  it("shows the locked state for private guest lists when viewer isn't organiser", () => {
    render(() => (
      <RsvpModal
        event={{ ...baseEvent, guestListVisibility: "private" }}

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

        currentProfileId="usr_alice"
        onClose={() => {}}
      />
    ));
    expect(screen.queryByText("This event's guest list is private.")).toBeNull();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });
});
