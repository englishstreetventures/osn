import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastError, mockToastSuccess } from "../helpers/toast";

const mockFetchLatest = vi.fn();
const mockFetchCounts = vi.fn();
const mockUpsert = vi.fn();
vi.mock("../../src/lib/rsvps", () => ({
  fetchLatestRsvps: (...args: unknown[]) => mockFetchLatest(...args),
  fetchRsvpCounts: (...args: unknown[]) => mockFetchCounts(...args),
  upsertMyRsvp: (...args: unknown[]) => mockUpsert(...args),
}));

// RsvpSection mounts <RsvpModal> when "See all" is clicked. The modal hits
// fetchRsvpsByStatus on mount via createResource, which we'd otherwise have
// to mock too — but the modal isn't under test here, so stub it.
vi.mock("../../src/components/RsvpModal", () => ({
  RsvpModal: (props: { onClose: () => void }) => {
    void props;
    return <div data-testid="rsvp-modal-stub" />;
  },
}));

import { RsvpSection } from "../../src/components/RsvpSection";

const baseEvent = {
  id: "evt_1",
  guestListVisibility: "public" as const,
  allowInterested: true,
  joinPolicy: "open" as const,
  createdByProfileId: "usr_alice",
};

describe("RsvpSection", () => {
  beforeEach(() => {
    mockFetchLatest.mockResolvedValue([]);
    mockFetchCounts.mockResolvedValue({ going: 0, interested: 0, not_going: 0, invited: 0 });
    mockUpsert.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    mockFetchLatest.mockReset();
    mockFetchCounts.mockReset();
    mockUpsert.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("renders attendees from fetchLatestRsvps", async () => {
    mockFetchLatest.mockResolvedValueOnce([
      {
        id: "rsvp_1",
        profileId: "usr_bob",
        eventId: "evt_1",
        status: "going",
        invitedByProfileId: null,
        isCloseFriend: false,
        createdAt: "2030-01-01T00:00:00Z",
        profile: { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
      },
    ]);
    const { container } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    await waitFor(() => {
      // Avatar wrapper is span.base\\:relative; fallback initials are inside a nested span.
      const wrapper = container.querySelector("span.base\\:relative");
      expect(wrapper?.textContent).toBe("BS");
    });
  });

  it("applies the close-friend ring on rows where isCloseFriend is true", async () => {
    mockFetchLatest.mockResolvedValueOnce([
      {
        id: "rsvp_1",
        profileId: "usr_bob",
        eventId: "evt_1",
        status: "going",
        invitedByProfileId: null,
        isCloseFriend: true,
        createdAt: "2030-01-01T00:00:00Z",
        profile: { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
      },
    ]);
    const { container } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    await waitFor(() => {
      // Close-friend ring is on the outer Avatar wrapper (span.base\\:relative).
      const avatar = container.querySelector("span.base\\:relative") as HTMLElement;
      // ring-green-500 is the centralised marker — see lib/ui.ts.
      expect(avatar?.classList.contains("ring-green-500")).toBe(true);
    });
  });

  it("renders 'No one's RSVPed yet' when latest list is empty", async () => {
    const { findByText } = render(() => (
      <RsvpSection event={baseEvent} accessToken={null} currentProfileId={null} />
    ));
    expect(await findByText("No one's RSVPed yet.")).toBeTruthy();
  });

  it("hides the 'Maybe' button when allowInterested is false", () => {
    const { queryByText } = render(() => (
      <RsvpSection
        event={{ ...baseEvent, allowInterested: false }}
        accessToken="tok"
        currentProfileId="usr_dan"
      />
    ));
    expect(queryByText("Maybe")).toBeNull();
    expect(queryByText("I'm going")).toBeTruthy();
    expect(queryByText("Can't make it")).toBeTruthy();
  });

  it("shows the 'invited' count only for guest_list events", async () => {
    mockFetchCounts.mockResolvedValueOnce({
      going: 0,
      interested: 0,
      not_going: 0,
      invited: 3,
    });
    const { findByText, queryByText, unmount } = render(() => (
      <RsvpSection
        event={{ ...baseEvent, joinPolicy: "guest_list" }}
        accessToken="tok"
        currentProfileId="usr_dan"
      />
    ));
    expect(await findByText("3 invited")).toBeTruthy();
    unmount();

    // Open-policy events never show the invited count.
    mockFetchCounts.mockResolvedValueOnce({
      going: 0,
      interested: 0,
      not_going: 0,
      invited: 3,
    });
    const { queryByText: queryByText2 } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    await waitFor(() => {
      expect(queryByText2("3 invited")).toBeNull();
    });
    void queryByText;
  });

  it("locks the inline list when guestListVisibility is private and viewer isn't organiser", async () => {
    const { findByText } = render(() => (
      <RsvpSection
        event={{ ...baseEvent, guestListVisibility: "private" }}
        accessToken="tok"
        currentProfileId="usr_dan"
      />
    ));
    expect(
      await findByText(
        "This event has a private guest list. Only the organiser can see who's going.",
      ),
    ).toBeTruthy();
  });

  it("clicking 'I'm going' calls upsertMyRsvp with the correct payload", async () => {
    const { getByText } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    fireEvent.click(getByText("I'm going"));
    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith("evt_1", "going", "tok");
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("toasts an error when upsertMyRsvp returns ok=false", async () => {
    mockUpsert.mockResolvedValueOnce({ ok: false, error: "Invitation required" });
    const { getByText } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    fireEvent.click(getByText("I'm going"));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Invitation required");
    });
  });

  it("blocks RSVP attempts when no access token is present and toasts a sign-in prompt", () => {
    const { getByText } = render(() => (
      <RsvpSection event={baseEvent} accessToken={null} currentProfileId={null} />
    ));
    fireEvent.click(getByText("I'm going"));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Sign in to RSVP");
  });

  it("clicking 'See all' opens the RsvpModal stub", async () => {
    const { getByText, findByTestId } = render(() => (
      <RsvpSection event={baseEvent} accessToken="tok" currentProfileId="usr_dan" />
    ));
    fireEvent.click(getByText("See all"));
    expect(await findByTestId("rsvp-modal-stub")).toBeTruthy();
  });
});
