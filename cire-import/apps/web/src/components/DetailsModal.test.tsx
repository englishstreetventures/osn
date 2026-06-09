import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { DetailsModal } from "./DetailsModal";
import type { EventSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  date: "2026-09-18",
  location: "The Sharma Residence",
  description: "An evening of henna",
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

describe("DetailsModal", () => {
  afterEach(() => cleanup());

  it("renders palette and description from event prop", () => {
    const { getByText, getByLabelText } = render(() => (
      <DetailsModal
        event={{
          ...baseEvent,
          dressCodeDescription: "Bright, festive colours.",
          dressCodePalette: [
            { name: "Marigold", color: "oklch(76.36% 0.1533 75.16)" },
            { name: "Fuchsia", color: "#ff00aa" },
          ],
        }}
        onClose={() => {}}
      />
    ));

    expect(getByText("Bright, festive colours.")).toBeTruthy();
    expect(getByLabelText("Marigold swatch")).toBeTruthy();
    expect(getByLabelText("Fuchsia swatch")).toBeTruthy();
    expect(getByText("Marigold")).toBeTruthy();
    expect(getByText("Fuchsia")).toBeTruthy();
  });

  it("renders fallback when both description and palette are null", () => {
    const { getByText, queryByText } = render(() => (
      <DetailsModal event={baseEvent} onClose={() => {}} />
    ));

    expect(getByText("Dress code details coming soon.")).toBeTruthy();
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("renders only description when palette is null", () => {
    const { getByText, queryByLabelText } = render(() => (
      <DetailsModal
        event={{
          ...baseEvent,
          dressCodeDescription: "Wear what you love.",
          dressCodePalette: null,
        }}
        onClose={() => {}}
      />
    ));

    expect(getByText("Wear what you love.")).toBeTruthy();
    expect(queryByLabelText(/swatch$/)).toBeNull();
  });

  it("renders only palette when description is null", () => {
    const { getByLabelText, queryByText } = render(() => (
      <DetailsModal
        event={{
          ...baseEvent,
          dressCodeDescription: null,
          dressCodePalette: [{ name: "Sage", color: "oklch(72.88% 0.0585 128.92)" }],
        }}
        onClose={() => {}}
      />
    ));

    expect(getByLabelText("Sage swatch")).toBeTruthy();
    expect(queryByText("Dress code details coming soon.")).toBeNull();
  });

  it("applies the supplied colour as inline background-color", () => {
    const { getByLabelText } = render(() => (
      <DetailsModal
        event={{
          ...baseEvent,
          dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
        }}
        onClose={() => {}}
      />
    ));

    const swatch = getByLabelText("Gold swatch") as HTMLElement;
    // jsdom normalises hex to rgb()
    expect(swatch.style.backgroundColor.replace(/\s+/g, "")).toBe("rgb(171,205,239)");
  });

  it("does not render swatches whose colour fails validation", () => {
    const { queryByLabelText, getByLabelText } = render(() => (
      <DetailsModal
        event={{
          ...baseEvent,
          dressCodePalette: [
            { name: "Evil", color: "expression(alert(1))" },
            { name: "Safe", color: "#abcdef" },
          ],
        }}
        onClose={() => {}}
      />
    ));

    expect(queryByLabelText("Evil swatch")).toBeNull();
    expect(getByLabelText("Safe swatch")).toBeTruthy();
  });
});
