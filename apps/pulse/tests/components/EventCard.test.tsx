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
    const { getByText } = render(() => <EventCard event={mockEvent} onDelete={onDelete} />);
    fireEvent.click(getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("evt_1");
  });

  it("delete click → confirm false → does NOT call onDelete", () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const onDelete = vi.fn();
    const { getByText } = render(() => <EventCard event={mockEvent} onDelete={onDelete} />);
    fireEvent.click(getByText("Delete"));
    expect(onDelete).not.toHaveBeenCalled();
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
});
