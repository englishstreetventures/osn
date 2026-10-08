import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { DetailsPanel } from "../../src/components/DetailsPanel";
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

const renderPanel = (event: EventSummary) =>
  render(() => <DetailsPanel event={event} siteUrl={SITE_URL} />);

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

  it("hosts the Add to Calendar control inside the details view", () => {
    const { getByRole } = renderPanel(baseEvent);
    const button = getByRole("button", { name: /add to calendar/i });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    // Opening it surfaces the calendar destinations (portalled to body).
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("Apple / Outlook (.ics)")).toBeTruthy();
  });

  it("renders a map preview that opens the venue in maps", () => {
    const { getByLabelText } = renderPanel(baseEvent);
    const link = getByLabelText(/open .* in maps/i) as HTMLAnchorElement;
    expect(link.href).toContain("https://www.google.com/maps/search/");
    expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
    expect(link.target).toBe("_blank");
  });

  it("renders the description in an About section", () => {
    const { getByText } = renderPanel(baseEvent);
    expect(getByText("About")).toBeTruthy();
    expect(getByText("An evening of henna")).toBeTruthy();
  });

  it("renders palette and dress code description when present", () => {
    const { getByText, getByLabelText } = renderPanel({
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

  it("renders only the palette when the dress code description is null", () => {
    const { getByLabelText, queryByText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Sage", color: "oklch(72.88% 0.0585 128.92)" }],
    });

    expect(getByLabelText("Sage swatch")).toBeTruthy();
    expect(queryByText("Dress Code")).toBeTruthy();
  });

  it("applies the supplied colour as an inline background-color", () => {
    const { getByLabelText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
    });

    const swatch = getByLabelText("Gold swatch") as HTMLElement;
    expect(swatch.style.backgroundColor.replace(/\s+/g, "")).toBe("rgb(171,205,239)");
  });

  it("does not render swatches whose colour fails validation", () => {
    const { queryByLabelText, getByLabelText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [
        { name: "Evil", color: "expression(alert(1))" },
        { name: "Safe", color: "#abcdef" },
      ],
    });

    expect(queryByLabelText("Evil swatch")).toBeNull();
    expect(getByLabelText("Safe swatch")).toBeTruthy();
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

describe("DetailsPanel — the way to the RSVP form", () => {
  afterEach(() => cleanup());

  it("offers none on its own", () => {
    const { queryByRole } = renderPanel(baseEvent);
    expect(queryByRole("button", { name: "RSVP for this event" })).toBeNull();
  });

  it("makes it the call to action, with Add to Calendar beside it as the quieter one", () => {
    // Answering is the one act that matters on the invite, so the RSVP button
    // takes the guest site's call-to-action shape and Add to Calendar steps
    // down to its outline — the reverse would make the calendar the thing to do.
    const onRsvp = vi.fn();
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={onRsvp} />
    ));

    const rsvp = getByRole("button", { name: "RSVP for this event" });
    expect(rsvp.className).toContain("base:border-ui-accent");
    expect(rsvp.className).toContain("base:hover:bg-ui-accent");
    expect(getByRole("button", { name: /add to calendar/i }).className).not.toContain("bg-gold");

    fireEvent.click(rsvp);
    expect(onRsvp).toHaveBeenCalledTimes(1);
  });

  it("gives way to a line saying the replies have closed, once they have", () => {
    const { queryByRole, getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        onRsvp={() => {}}
        rsvpClosed
        rsvpClosedOn="Sunday 1 September 2999"
      />
    ));

    expect(queryByRole("button", { name: "RSVP for this event" })).toBeNull();
    expect(getByRole("status").textContent).toBe("RSVPs closed on Sunday 1 September 2999.");
  });

  it("says the replies have closed without a date when it has none", () => {
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={() => {}} rsvpClosed />
    ));
    expect(getByRole("status").textContent).toBe("RSVPs have closed.");
  });

  it("puts focus on its heading when the deadline removes the RSVP button from under it", () => {
    const [closed, setClosed] = createSignal(false);
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={() => {}} rsvpClosed={closed()} />
    ));
    getByRole("button", { name: "RSVP for this event" }).focus();

    setClosed(true);

    expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
  });

  it("leaves focus alone when it is not the panel on screen", () => {
    // A hidden panel holds no focus the guest can see; pulling focus into it
    // would put the guest somewhere invisible.
    const [closed, setClosed] = createSignal(false);
    const { getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        onRsvp={() => {}}
        rsvpClosed={closed()}
        active={false}
      />
    ));
    getByRole("button", { name: "RSVP for this event" }).focus();

    setClosed(true);

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus where the guest put it if it was not on the RSVP button", () => {
    const [closed, setClosed] = createSignal(false);
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={() => {}} rsvpClosed={closed()} />
    ));
    const calendar = getByRole("button", { name: /add to calendar/i });
    calendar.focus();

    setClosed(true);

    expect(document.activeElement).toBe(calendar);
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
    const { container, getByText } = renderPanel(richEvent);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(trackerScript()).toBeNull();
    // What stands in for them: the CSS map card naming the venue, and the
    // moodboard's own placeholder and link-out.
    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    expect(container.textContent ?? "").toContain("Allow Pinterest moodboards");
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

    // And no permission notice standing in for either of them.
    expect(container.textContent ?? "").not.toContain("Allow Pinterest moodboards");
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
    // Refusing costs the rich embeds and nothing else: the CSS map card still
    // names the venue and links out, and the moodboard link-out is still there.
    seedConsentForTest({ pinterest: false, maps: false });
    const { container, getByText } = renderPanel(richEvent);

    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    const moodboardLink = container.querySelector<HTMLAnchorElement>(
      'a[href="' + PINTEREST_URL + '"]',
    );
    expect(moodboardLink).not.toBeNull();
    expect(moodboardLink!.textContent).toContain("View moodboard on Pinterest");
  });
});
