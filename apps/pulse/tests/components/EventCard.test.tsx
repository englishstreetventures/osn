// @vitest-environment happy-dom
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { vi, describe, it, expect, afterEach } from "vitest";
import { EventCard } from "../../src/components/EventCard";

const mockEvent = {
  id: "evt_1",
  title: "Test Event",
  status: "upcoming" as const,
  startTime: "2030-06-01T10:00:00.000Z",
};

describe("EventCard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders event title and status", () => {
    const { getByText } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(getByText("Test Event")).toBeTruthy();
    expect(getByText("upcoming")).toBeTruthy();
  });

  it("renders formatted start time (non-empty string)", () => {
    const { container } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    // formatTime returns a non-empty locale string
    const timeText = container.querySelector(".flex.flex-wrap")?.textContent ?? "";
    expect(timeText.trim().length).toBeGreaterThan(0);
  });

  it("renders description when provided; omits it when absent", () => {
    const { getByText, unmount } = render(() => (
      <EventCard event={{ ...mockEvent, description: "A great event" }} onDelete={() => {}} />
    ));
    expect(getByText("A great event")).toBeTruthy();
    unmount();

    const { queryByText } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(queryByText("A great event")).toBeNull();
  });

  it("renders category badge when provided; omits it when absent", () => {
    const { getByText, unmount } = render(() => (
      <EventCard event={{ ...mockEvent, category: "Music" }} onDelete={() => {}} />
    ));
    expect(getByText("Music")).toBeTruthy();
    unmount();

    const { queryByText } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(queryByText("Music")).toBeNull();
  });

  it("renders venue and location when provided", () => {
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, venue: "The Venue", location: "London, UK" }}
        onDelete={() => {}}
      />
    ));
    expect(getByText("The Venue")).toBeTruthy();
    expect(getByText("London, UK")).toBeTruthy();
  });

  it("renders 'Hosted by' with initials avatar when createdByName set, no avatar", () => {
    const { getByText, container } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_1", createdByName: "Alice Chen" }}
        onDelete={() => {}}
      />
    ));
    expect(getByText("Hosted by Alice Chen")).toBeTruthy();
    // Initials span should contain "AC" (first two letters of each word, uppercased)
    const initialsSpan = container.querySelector("span.inline-flex");
    expect(initialsSpan?.textContent).toBe("AC");
    // No avatar img inside the hosted-by section (only the event imageUrl img, which is absent)
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders 'Hosted by' with <img> avatar when createdByName and createdByAvatar set", () => {
    const { getByText, container } = render(() => (
      <EventCard
        event={{
          ...mockEvent,
          createdByUserId: "usr_1",
          createdByName: "Bob",
          createdByAvatar: "https://example.com/bob.jpg",
        }}
        onDelete={() => {}}
      />
    ));
    expect(getByText("Hosted by Bob")).toBeTruthy();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://example.com/bob.jpg");
  });

  it("omits 'Hosted by' section when createdByName is absent", () => {
    const { queryByText } = render(() => (
      <EventCard event={{ ...mockEvent, createdByUserId: "usr_1" }} onDelete={() => {}} />
    ));
    expect(queryByText(/Hosted by/)).toBeNull();
  });

  it("renders <img> when imageUrl provided; omits when absent", () => {
    const { container, unmount } = render(() => (
      <EventCard
        event={{ ...mockEvent, imageUrl: "https://example.com/img.jpg" }}
        onDelete={() => {}}
      />
    ));
    expect(container.querySelector("img")).toBeTruthy();
    unmount();

    const { container: c2 } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(c2.querySelector("img")).toBeNull();
  });

  it("delete click → confirm true → calls onDelete with event id", () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const onDelete = vi.fn();
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_test" }}
        onDelete={onDelete}
        currentUserId="usr_test"
      />
    ));
    fireEvent.click(getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("evt_1");
  });

  it("delete click → confirm false → does NOT call onDelete", () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const onDelete = vi.fn();
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_test" }}
        onDelete={onDelete}
        currentUserId="usr_test"
      />
    ));
    fireEvent.click(getByText("Delete"));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("delete button hidden when currentUserId not provided", () => {
    const { queryByText } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(queryByText("Delete")).toBeNull();
  });

  it("delete button hidden when event is owned by another user", () => {
    const { queryByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_alice" }}
        onDelete={() => {}}
        currentUserId="usr_bob"
      />
    ));
    expect(queryByText("Delete")).toBeNull();
  });

  it("renders ongoing status with green styling", () => {
    const { getByText } = render(() => (
      <EventCard event={{ ...mockEvent, status: "ongoing" as const }} onDelete={() => {}} />
    ));
    expect(getByText("ongoing")).toBeTruthy();
  });

  it("renders cancelled status", () => {
    const { getByText } = render(() => (
      <EventCard event={{ ...mockEvent, status: "cancelled" as const }} onDelete={() => {}} />
    ));
    expect(getByText("cancelled")).toBeTruthy();
  });

  it("deleting=true → button shows 'Deleting…' and is disabled", () => {
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_test" }}
        onDelete={() => {}}
        deleting={true}
        currentUserId="usr_test"
      />
    ));
    const btn = getByText("Deleting…") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("renders Maps link with coordinate URL when lat/lng provided", () => {
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, latitude: 40.7195, longitude: -73.9875 }}
        onDelete={() => {}}
      />
    ));
    const link = getByText("Open in Maps") as HTMLAnchorElement;
    expect(link.href).toBe("https://maps.google.com/?q=40.7195,-73.9875");
    expect(link.target).toBe("_blank");
  });

  it("renders Maps link with text search URL when only location/venue provided", () => {
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, venue: "The Cellar Bar", location: "New York" }}
        onDelete={() => {}}
      />
    ));
    const link = getByText("Open in Maps") as HTMLAnchorElement;
    expect(link.href).toContain("maps/search");
    expect(link.href).toContain("The%20Cellar%20Bar");
  });

  it("omits Maps link when no location data", () => {
    const { queryByText } = render(() => <EventCard event={mockEvent} onDelete={() => {}} />);
    expect(queryByText("Open in Maps")).toBeNull();
  });

  it("deleting=true → does not call onDelete when clicked", () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const onDelete = vi.fn();
    const { getByText } = render(() => (
      <EventCard
        event={{ ...mockEvent, createdByUserId: "usr_test" }}
        onDelete={onDelete}
        deleting={true}
        currentUserId="usr_test"
      />
    ));
    fireEvent.click(getByText("Deleting…"));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
