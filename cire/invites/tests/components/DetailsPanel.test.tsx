import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { DetailsPanel } from "../../src/components/DetailsPanel";
import type { EventSummary, FamilyMember } from "../../src/components/types";
import { resetConsentForTest, seedConsentForTest } from "../test-support/consent";
import { pinGuestTimeZone } from "../test-support/time-zone";

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

const renderPanel = (event: EventSummary) =>
  render(() => <DetailsPanel event={event} siteUrl={SITE_URL} />);

/** A colour swatch, by the name the organiser gave it: one item in the list. */
const swatch = (getAllByRole: (role: "listitem") => HTMLElement[], name: string) =>
  getAllByRole("listitem").find((item) => item.textContent === name);

// The "Your time" line follows the zone the runner is in unless it is pinned:
// a guest in Sydney, like the events below, sees none.
let unpinZone: () => void = () => {};
beforeEach(() => {
  unpinZone = pinGuestTimeZone("Australia/Sydney");
});
afterEach(() => unpinZone());

describe("DetailsPanel", () => {
  afterEach(() => cleanup());

  it("shows the event name and the timezone-aware date / time range", () => {
    const { getByText, getByRole } = renderPanel(baseEvent);

    // "Details" is part of the heading, so a guest who lands on it hears
    // which panel this is as well as which event.
    expect(getByRole("heading", { name: "Details, Mehndi" })).toBeTruthy();
    expect(getByText(/Friday\s+18 September 2026/)).toBeTruthy();
    // Time range rendered in the event's own timezone (4pm–10pm Sydney).
    expect(getByText(/4:00\s*pm\s*–\s*10:00\s*pm/i)).toBeTruthy();
  });

  it("renders the description in an About section", () => {
    const { getByText } = renderPanel(baseEvent);
    expect(getByText("About")).toBeTruthy();
    expect(getByText("An evening of henna")).toBeTruthy();
  });

  it("collapses a sparse event to its date, with no empty label or hairline", () => {
    // What the import requires and nothing else: a name, a start, a timezone.
    // No venue means nothing can open a map, so no "Where"; nothing for the
    // occasion means no hairline over an empty space.
    const { container, queryByText, getByText } = renderPanel({
      ...baseEvent,
      description: "",
      endAt: "",
      address: null,
      mapsUrl: null,
    });
    expect(getByText(/Friday\s+18 September 2026/)).toBeTruthy();
    expect(container.querySelector("dt")?.textContent).toBe("When");
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["When"]);
    expect(queryByText("About")).toBeNull();
    expect(container.querySelector(".border-t")).toBeNull();
  });

  it("shows no About for a description of only spaces", () => {
    const { queryByText } = renderPanel({ ...baseEvent, description: "   \n " });
    expect(queryByText("About")).toBeNull();
  });

  it("shows no Where for a maps link that is not http(s) and no address", () => {
    const { container } = renderPanel({
      ...baseEvent,
      address: "  ",
      mapsUrl: "javascript:alert(1)",
    });
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["When"]);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("spells the timezone out, and gives a guest elsewhere their own time", () => {
    const sydney = renderPanel(baseEvent);
    expect(sydney.getByText(/AEST \(Sydney time\)/)).toBeTruthy();
    expect(sydney.queryByText(/Your time/)).toBeNull();
    cleanup();
    unpinZone();

    unpinZone = pinGuestTimeZone("Europe/London");
    const london = renderPanel(baseEvent);
    expect(london.getByText("Your time: Fri 7:00 am – 1:00 pm (GMT+1)")).toBeTruthy();
  });

  it("names who is invited when it is not the whole household", () => {
    const member = (firstName: string, eventIds: string[]): FamilyMember => ({
      guestId: `g-${firstName}`,
      firstName,
      lastName: "Sharma",
      nickname: null,
      eventIds,
    });
    const household = [
      member("Alex", [baseEvent.id]),
      member("Sam", [baseEvent.id]),
      member("Priya", []),
    ];
    const some = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} members={household} />
    ));
    expect(some.getByText("Who's invited")).toBeTruthy();
    expect(some.getByText(/Alex and Sam/)).toBeTruthy();
    cleanup();

    const all = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        members={["Alex", "Sam", "Priya"].map((name) => member(name, [baseEvent.id]))}
      />
    ));
    expect(all.queryByText("Who's invited")).toBeNull();
  });

  it("renders palette and dress code description when present", () => {
    const { getByText, getAllByRole } = renderPanel({
      ...baseEvent,
      dressCodeDescription: "Bright, festive colours.",
      dressCodePalette: [
        { name: "Marigold", color: "oklch(76.36% 0.1533 75.16)" },
        { name: "Fuchsia", color: "#ff00aa" },
      ],
    });

    expect(getByText("Bright, festive colours.")).toBeTruthy();
    expect(swatch(getAllByRole, "Marigold")).toBeTruthy();
    expect(swatch(getAllByRole, "Fuchsia")).toBeTruthy();
    // The circle is the colour itself, and says nothing the name does not.
    const circle = swatch(getAllByRole, "Marigold")!.querySelector("span");
    expect(circle?.getAttribute("aria-hidden")).toBe("true");
  });

  it("omits the dress code section entirely when there is no dress code", () => {
    const { queryByText } = renderPanel(baseEvent);
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("omits the inspiration section when there is no pinterest board", () => {
    const { queryByText } = renderPanel(baseEvent);
    expect(queryByText("Inspiration")).toBeNull();
  });

  it("omits the inspiration section for a whitespace-only pinterest URL", () => {
    const { queryByText } = renderPanel({ ...baseEvent, pinterestUrl: "   " });
    expect(queryByText("Inspiration")).toBeNull();
  });

  it("renders the inspiration section for a real pinterest URL", () => {
    const { getByText } = renderPanel({
      ...baseEvent,
      pinterestUrl: "https://pinterest.com/board",
    });
    expect(getByText("Inspiration")).toBeTruthy();
  });

  it("omits the dress code section for a whitespace-only description and empty palette", () => {
    const { queryByText } = renderPanel({
      ...baseEvent,
      dressCodeDescription: "   ",
      dressCodePalette: [],
    });
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("draws no colour list for a dress code that has words and no colours", () => {
    // An empty list is still a list to a screen reader.
    const { getByText, queryByRole } = renderPanel({
      ...baseEvent,
      dressCodeDescription: "Cocktail.",
      dressCodePalette: [],
    });
    expect(getByText("Cocktail.")).toBeTruthy();
    expect(queryByRole("list")).toBeNull();
  });

  it("omits the dress code section when every colour in it is refused", () => {
    // Refused colours are never painted, so a palette of only those is no
    // dress code: the label would stand over an empty space.
    const { queryByText } = renderPanel({
      ...baseEvent,
      dressCodeDescription: "  ",
      dressCodePalette: [{ name: "Evil", color: "expression(alert(1))" }],
    });
    expect(queryByText("Dress Code")).toBeNull();
  });

  it("renders only the palette when the dress code description is null", () => {
    const { getAllByRole, queryByText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Sage", color: "oklch(72.88% 0.0585 128.92)" }],
    });

    expect(swatch(getAllByRole, "Sage")).toBeTruthy();
    expect(queryByText("Dress Code")).toBeTruthy();
  });

  it("applies the supplied colour as an inline background-color", () => {
    const { getAllByRole } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
    });

    const circle = swatch(getAllByRole, "Gold")!.querySelector<HTMLElement>("span")!;
    expect(circle.style.backgroundColor.replace(/\s+/g, "")).toBe("rgb(171,205,239)");
  });

  it("does not render swatches whose colour fails validation", () => {
    const { getAllByRole, queryByText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [
        { name: "Evil", color: "expression(alert(1))" },
        { name: "Safe", color: "#abcdef" },
      ],
    });

    expect(queryByText("Evil")).toBeNull();
    expect(getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Safe"]);
  });

  it("gives the sheet a heading it can focus and name the dialog by", () => {
    let received: HTMLHeadingElement | undefined;
    const { getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        titleId="details-title"
        headingRef={(el) => (received = el)}
      />
    ));

    const heading = getByRole("heading", { name: "Details, Mehndi" });
    expect(heading.id).toBe("details-title");
    // Focusable by script only: the sheet moves focus here on a switch, and a
    // heading has no business in the Tab order.
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(received).toBe(heading);
  });
});

describe("DetailsPanel — the deadline", () => {
  afterEach(() => cleanup());

  it("offers no way to the RSVP form of its own: that is the sheet's", () => {
    const { queryByRole } = renderPanel(baseEvent);
    expect(queryByRole("button", { name: /RSVP/ })).toBeNull();
  });

  it("says the replies have closed, on which day, and the household's next step", () => {
    const { getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        rsvpClosed
        rsvpClosedOn="Sunday 1 September 2999"
      />
    ));
    expect(getByRole("status").textContent).toBe(
      "RSVPs closed on Sunday 1 September 2999. To reply now, please contact the couple directly.",
    );
  });

  it("tells a household with a reply on file how to change it", () => {
    const { getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        rsvpClosed
        replied
        rsvpClosedOn="Sunday 1 September 2999"
      />
    ));
    expect(getByRole("status").textContent).toBe(
      "RSVPs closed on Sunday 1 September 2999. To change your household's reply, please contact the couple directly.",
    );
  });

  it("says the replies have closed without a date when it has none", () => {
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} rsvpClosed />
    ));
    expect(getByRole("status").textContent).toBe(
      "RSVPs have closed. To reply now, please contact the couple directly.",
    );
  });

  it("says nothing while replies are open", () => {
    const { getByRole } = renderPanel(baseEvent);
    expect(getByRole("status").textContent).toBe("");
  });
});

/**
 * The consent posture checked through the real details panel, rather than
 * through each embed component in isolation. The panel is rendered on its own,
 * without the sheet around it; `MapPreview.browser.test.tsx` renders the map
 * inside the real sheet.
 *
 * This is the integration the unit tests don't cover: `MapPreview` and
 * `PinterestBoard` each pass on their own, but what a guest actually meets is
 * the details panel with both mounted inside it, hydrating together off one
 * shared store. If the defaults, the gate and the hydration order ever disagree,
 * this is where it shows up.
 */
describe("DetailsPanel — each embed waits for its own switch", () => {
  const MAPS_KEY = "test-embed-key";
  const PINTEREST_URL = "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/";

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
    const { container, getByText } = renderPanel(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
    // What stands in for them: the venue's address over the drawn map card,
    // and the moodboard block with its link out and its Show it here.
    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    expect(container.textContent ?? "").toContain("Show it here");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href="' + PINTEREST_URL + '"]'),
    ).not.toBeNull();
  });

  it("renders BOTH once the guest has allowed both", () => {
    seedConsentForTest({ pinterest: true, maps: true });
    const { container } = renderPanel(richEvent);

    // The venue map: a live Google Maps Embed iframe, not the CSS fallback card.
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src") ?? "").toContain(
      "https://www.google.com/maps/embed/v1/place?",
    );

    // The moodboard: the widget anchor mounted and the tracker requested.
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(trackerScript()).not.toBeNull();

    // And no offer to show what is already showing.
    expect(container.textContent ?? "").not.toContain("Show it here");
  });

  it("renders only the map when only Google Maps is allowed", () => {
    seedConsentForTest({ maps: true });
    const { container } = renderPanel(richEvent);

    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
  });

  it("renders only the moodboard when only Pinterest is allowed", () => {
    seedConsentForTest({ pinterest: true });
    const { container, getByText } = renderPanel(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(trackerScript()).not.toBeNull();
  });

  it('blocks BOTH after "Reject all"', () => {
    seedConsentForTest({ pinterest: false, maps: false });
    const { container } = renderPanel(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
  });

  it("keeps the venue and the moodboard reachable even when both embeds are off", () => {
    // Refusing costs the rich embeds and nothing else: the venue row still
    // names the venue and links out, and the moodboard link-out is still there.
    seedConsentForTest({ pinterest: false, maps: false });
    const { container, getByText } = renderPanel(richEvent);

    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    const moodboardLink = container.querySelector<HTMLAnchorElement>(
      'a[href="' + PINTEREST_URL + '"]',
    );
    expect(moodboardLink).not.toBeNull();
    expect(moodboardLink!.textContent).toContain("Open on Pinterest");
  });
});
