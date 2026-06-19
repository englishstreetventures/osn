import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import { DetailsModal } from "./DetailsModal";
import type { EventSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

const SITE_URL = "https://invite.example.com/abc-123";

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  date: "2026-09-18",
  location: "The Sharma Residence",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Strathfield",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
};

const renderModal = (event: EventSummary) =>
  render(() => <DetailsModal event={event} siteUrl={SITE_URL} onClose={() => {}} />);

describe("DetailsModal", () => {
  afterEach(() => cleanup());

  it("shows the event name and the timezone-aware date / time range", () => {
    const { getByText, getByRole } = renderModal(baseEvent);

    expect(getByRole("heading", { name: "Mehndi" })).toBeTruthy();
    expect(getByText(/Friday\s+18 September 2026/)).toBeTruthy();
    // Time range rendered in the event's own timezone (4pm–10pm Sydney).
    expect(getByText(/4:00\s*pm\s*–\s*10:00\s*pm/i)).toBeTruthy();
  });

  it("hosts the Add to Calendar control inside the details view", () => {
    const { getByRole } = renderModal(baseEvent);
    const button = getByRole("button", { name: /add to calendar/i });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    // Opening it surfaces the calendar destinations (portalled to body).
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("Apple / Outlook (.ics)")).toBeTruthy();
  });

  it("renders a map preview that opens the venue in maps", () => {
    const { getByLabelText } = renderModal(baseEvent);
    const link = getByLabelText(/open .* in maps/i) as HTMLAnchorElement;
    expect(link.href).toContain("https://www.google.com/maps/search/");
    expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
    expect(link.target).toBe("_blank");
  });

  it("renders the description in an About section", () => {
    const { getByText } = renderModal(baseEvent);
    expect(getByText("About")).toBeTruthy();
    expect(getByText("An evening of henna")).toBeTruthy();
  });

  it("renders palette and dress code description when present", () => {
    const { getByText, getByLabelText } = renderModal({
      ...baseEvent,
      dressCodeDescription: "Bright, festive colours.",
      dressCodePalette: [
        { name: "Marigold", color: "oklch(76.36% 0.1533 75.16)" },
        { name: "Fuchsia", color: "#ff00aa" },
      ],
    });

    expect(getByText("Bright, festive colours.")).toBeTruthy();
    expect(getByLabelText("Marigold swatch")).toBeTruthy();
    expect(getByLabelText("Fuchsia swatch")).toBeTruthy();
    expect(getByText("Marigold")).toBeTruthy();
  });

  it("omits the dress code section entirely when there is no dress code", () => {
    const { queryByText } = renderModal(baseEvent);
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("omits the inspiration section when there is no pinterest board", () => {
    const { queryByText } = renderModal(baseEvent);
    expect(queryByText("Inspiration")).toBeNull();
  });

  it("omits the inspiration section for a whitespace-only pinterest URL", () => {
    const { queryByText } = renderModal({ ...baseEvent, pinterestUrl: "   " });
    expect(queryByText("Inspiration")).toBeNull();
  });

  it("renders the inspiration section for a real pinterest URL", () => {
    const { getByText } = renderModal({
      ...baseEvent,
      pinterestUrl: "https://pinterest.com/board",
    });
    expect(getByText("Inspiration")).toBeTruthy();
  });

  it("omits the dress code section for a whitespace-only description and empty palette", () => {
    const { queryByText } = renderModal({
      ...baseEvent,
      dressCodeDescription: "   ",
      dressCodePalette: [],
    });
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("renders only the palette when the dress code description is null", () => {
    const { getByLabelText, queryByText } = renderModal({
      ...baseEvent,
      dressCodePalette: [{ name: "Sage", color: "oklch(72.88% 0.0585 128.92)" }],
    });

    expect(getByLabelText("Sage swatch")).toBeTruthy();
    expect(queryByText("Dress Code")).toBeTruthy();
  });

  it("applies the supplied colour as an inline background-color", () => {
    const { getByLabelText } = renderModal({
      ...baseEvent,
      dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
    });

    const swatch = getByLabelText("Gold swatch") as HTMLElement;
    expect(swatch.style.backgroundColor.replace(/\s+/g, "")).toBe("rgb(171,205,239)");
  });

  it("does not render swatches whose colour fails validation", () => {
    const { queryByLabelText, getByLabelText } = renderModal({
      ...baseEvent,
      dressCodePalette: [
        { name: "Evil", color: "expression(alert(1))" },
        { name: "Safe", color: "#abcdef" },
      ],
    });

    expect(queryByLabelText("Evil swatch")).toBeNull();
    expect(getByLabelText("Safe swatch")).toBeTruthy();
  });
});
