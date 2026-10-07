import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { DetailsModal } from "../../src/components/DetailsModal";
import type { EventSummary } from "../../src/components/types";
import { resetConsentForTest, seedConsentForTest } from "../../src/lib/consent/testing";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

const SITE_URL = "https://invite.example.com/abc-123";

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
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
  imageUrl: null,
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

/**
 * End-to-end check of the consent posture through the REAL modal tree, rather
 * than through each embed component in isolation.
 *
 * This is the integration the unit tests don't cover: `MapPreview` and
 * `PinterestBoard` each pass on their own, but what a guest actually meets is
 * the details sheet with both mounted inside it, hydrating together off one
 * shared store. If the defaults, the gate and the hydration order ever disagree,
 * this is where it shows up.
 */
describe("DetailsModal — third-party embeds wait for the guest's yes", () => {
  const MAPS_KEY = "test-embed-key";
  const PINTEREST_URL =
    "https://www.pinterest.com.au/pcvmpasupati/catholic-wedding-guest-moodboard/";

  const richEvent: EventSummary = {
    ...baseEvent,
    pinterestUrl: PINTEREST_URL,
    dressCodeDescription: "Festive Indian",
  };

  /** The injected Pinterest tracker, if the embed decided to load it. */
  const trackerScript = () =>
    document.querySelector<HTMLScriptElement>('script[src*="pinit_main.js"]');

  beforeEach(() => {
    resetConsentForTest();
    vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", MAPS_KEY);
  });

  afterEach(() => {
    cleanup();
    for (const script of document.querySelectorAll('script[src*="pinit_main.js"]')) {
      script.remove();
    }
    vi.unstubAllEnvs();
    resetConsentForTest();
  });

  it("loads NEITHER the Google map nor the Pinterest board for a guest with no consent cookie", () => {
    const { container, getByText } = renderModal(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
    // What stands in for them: the CSS map card naming the venue, and the
    // moodboard's own placeholder and link-out.
    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    expect(container.textContent ?? "").toContain("Allow third-party content");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href="' + PINTEREST_URL + '"]'),
    ).not.toBeNull();
  });

  it("renders BOTH once the guest has allowed third-party content", () => {
    seedConsentForTest({ embeds: true });
    const { container } = renderModal(richEvent);

    // The venue map: a live Google Maps Embed iframe, not the CSS fallback card.
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src") ?? "").toContain(
      "https://www.google.com/maps/embed/v1/place?",
    );

    // The moodboard: the widget anchor mounted and the tracker requested.
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(trackerScript()).not.toBeNull();

    // And no permission notice standing in for either of them.
    expect(container.textContent ?? "").not.toContain("Allow third-party content");
  });

  it("blocks BOTH once the guest switches third-party content off", () => {
    seedConsentForTest({ embeds: false });
    const { container } = renderModal(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
  });

  it("keeps the venue and the moodboard reachable even when both embeds are off", () => {
    // Refusing costs the rich embeds and nothing else: the CSS map card still
    // names the venue and links out, and the moodboard link-out is still there.
    seedConsentForTest({ embeds: false });
    const { container, getByText } = renderModal(richEvent);

    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    const moodboardLink = container.querySelector<HTMLAnchorElement>(
      'a[href="' + PINTEREST_URL + '"]',
    );
    expect(moodboardLink).not.toBeNull();
    expect(moodboardLink!.textContent).toContain("View moodboard on Pinterest");
  });
});
