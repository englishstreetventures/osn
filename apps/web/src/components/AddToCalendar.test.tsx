import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@solidjs/testing-library";
import { AddToCalendar } from "./AddToCalendar";
import type { EventSummary } from "./types";

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Reception, Cocktail Hour & Dinner",
  date: "2026-09-18",
  location: "The Sharma Residence",
  description: "An evening of feasting",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
};

const SITE_URL = "https://invite.example.com/abc-123";

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let urlCounter = 0;
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  urlCounter = 0;
  createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
  revokeObjectURL = vi.fn();
  // Patch the methods on the real URL constructor so `new URL(...)` keeps
  // working (jsdom doesn't ship createObjectURL by default).
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  if (originalCreate === undefined) {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  } else {
    URL.createObjectURL = originalCreate;
  }
  if (originalRevoke === undefined) {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  } else {
    URL.revokeObjectURL = originalRevoke;
  }
});

describe("AddToCalendar", () => {
  it("toggles aria-expanded when the button is clicked", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = getByRole("button", { name: /add to calendar/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a Google Calendar link with the correct href when open", () => {
    const { getByRole, getByText } = render(() => (
      <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
    ));
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const link = getByText("Google Calendar") as HTMLAnchorElement;
    expect(link.href).toContain("https://calendar.google.com/calendar/render");
    expect(link.href).toContain("text=Reception%2C+Cocktail+Hour+%26+Dinner");
    expect(link.href).toContain("ctz=Australia%2FSydney");
    expect(link.href).toContain("dates=20260918T060000Z%2F20260918T120000Z");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("renders an .ics download link with a sanitised filename", () => {
    const { getByRole, getByText } = render(() => (
      <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
    ));
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const link = getByText("Apple / Outlook (.ics)") as HTMLAnchorElement;
    // Download attribute must be sanitised to printable ASCII (no spaces, no
    // commas, no &). "Reception, Cocktail Hour & Dinner" -> underscores.
    expect(link.getAttribute("download")).toBe("Reception__Cocktail_Hour___Dinner.ics");
    expect(link.getAttribute("href")).toMatch(/^blob:mock-/);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("closes when Escape is pressed", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the user clicks outside the popover", () => {
    const { getByRole } = render(() => (
      <div>
        <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
        <span data-testid="outside">outside</span>
      </div>
    ));
    const button = getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseDown(document.body);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not allocate an object URL until the popover opens", () => {
    const { unmount } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    expect(createObjectURL).toHaveBeenCalledTimes(0);
    unmount();
  });

  it("revokes the object URL on unmount once the popover has been opened", () => {
    const { getByRole, unmount } = render(() => (
      <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
    ));
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const created = createObjectURL.mock.results[0].value as string;
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(created);
  });
});
