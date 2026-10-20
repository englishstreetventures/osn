import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { DetailsPanel } from "../../src/components/DetailsPanel";
import type { EventSummary, FamilyMember } from "../../src/components/types";
import { resetConsentForTest, seedConsentForTest } from "../test-support/consent";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

// The guest's zone is the machine's in a real browser; pinned here so the
// "Your time" line does not depend on where the suite runs. Defaults to the
// fixture's own zone, which shows no line.
const guestZone = vi.hoisted(() => ({ value: "Australia/Sydney" }));
vi.mock("../../src/components/event-details", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/event-details")>()),
  guestTimeZone: () => guestZone.value,
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
    // Time range rendered in the event's own timezone (4pm–10pm Sydney), with
    // the zone spelt out.
    expect(getByText(/4:00\s*pm\s*–\s*10:00\s*pm · AEST \(Sydney time\)/i)).toBeTruthy();
  });

  it("leads with the key facts as a description list, each named for a screen reader", () => {
    const { container } = renderPanel(baseEvent);
    const terms = [...container.querySelectorAll("dl > div > dt")].map((dt) => dt.textContent);
    expect(terms).toEqual(["When", "Where"]);
    // The glyph beside each term is decoration.
    for (const svg of container.querySelectorAll("dt svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("collapses a sparse event to its title and its date", () => {
    // Name, start and timezone only: no "Where" with nothing under it, no
    // "About" over a description of spaces, and no hairline over nothing.
    const { container, queryByText } = renderPanel({
      ...baseEvent,
      description: "   ",
      endAt: "",
      address: null,
      mapsUrl: null,
    });
    expect(queryByText("Where")).toBeNull();
    expect(queryByText("About")).toBeNull();
    expect(container.querySelector(".border-t")).toBeNull();
    expect(queryByText(/Friday\s+18 September 2026/)).toBeTruthy();
  });

  it("shows the Where row for a maps link alone", () => {
    const { getByText, getByRole } = renderPanel({
      ...baseEvent,
      address: null,
      mapsUrl: "https://maps.google.com/?q=x",
    });
    expect(getByText("Where")).toBeTruthy();
    expect(getByRole("link", { name: "Open in maps" })).toBeTruthy();
  });

  it("renders the description in an About section, under one hairline", () => {
    const { getByText, container } = renderPanel(baseEvent);
    expect(getByText("About")).toBeTruthy();
    expect(getByText("An evening of henna")).toBeTruthy();
    // One rule between the key facts and the occasion, none between sections.
    expect(container.querySelectorAll(".border-t")).toHaveLength(1);
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
    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Marigold", "Fuchsia"]);
  });

  it("writes swatch names as the organiser typed them, not in capitals", () => {
    const { getByText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Dusty rose", color: "#d8a7a7" }],
    });
    const name = getByText("Dusty rose");
    expect(name.className.split(/\s+/)).not.toContain("uppercase");
  });

  it("outlines each swatch in the strong border, so a swatch the sheet's colour still shows", () => {
    const { getByRole } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
    });
    const circle = getByRole("listitem").querySelector<HTMLElement>("[aria-hidden='true']")!;
    expect(circle.className.split(/\s+/)).toContain("border-border-strong");
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

  it("omits the inspiration section for a URL the board would not draw", () => {
    const { queryByText } = renderPanel({
      ...baseEvent,
      pinterestUrl: "https://evil.com/user/board",
    });
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

  it("writes no description paragraph for a description of spaces beside a palette", () => {
    const { getByText } = renderPanel({
      ...baseEvent,
      dressCodeDescription: "   ",
      dressCodePalette: [{ name: "Sage", color: "#9cae8f" }],
    });
    const section = getByText("Dress Code").closest("section")!;
    expect(section.querySelectorAll("p")).toHaveLength(0);
  });

  it("links the board by its URL without the spaces an organiser pasted round it", () => {
    const { getByRole } = renderPanel({ ...baseEvent, pinterestUrl: "  https://pin.it/3xKp9Qd  " });
    expect(getByRole("link", { name: /Open on Pinterest/ }).getAttribute("href")).toBe(
      "https://pin.it/3xKp9Qd",
    );
  });

  it("renders only the palette when the dress code description is null", () => {
    const { getByRole, queryByText } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Sage", color: "oklch(72.88% 0.0585 128.92)" }],
    });

    expect(getByRole("listitem").textContent).toBe("Sage");
    expect(queryByText("Dress Code")).toBeTruthy();
  });

  it("applies the supplied colour as an inline background-color", () => {
    const { getByRole } = renderPanel({
      ...baseEvent,
      dressCodePalette: [{ name: "Gold", color: "#abcdef" }],
    });

    const swatch = getByRole("listitem").querySelector<HTMLElement>("[aria-hidden='true']")!;
    expect(swatch.style.backgroundColor.replace(/\s+/g, "")).toBe("rgb(171,205,239)");
  });

  it("does not render swatches whose colour fails validation", () => {
    const { container, getAllByRole } = renderPanel({
      ...baseEvent,
      dressCodePalette: [
        { name: "Evil", color: "expression(alert(1))" },
        { name: "Safe", color: "#abcdef" },
      ],
    });

    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Safe"]);
    expect(container.innerHTML).not.toContain("expression(");
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

  it("makes it the call to action and the first control, with Add to calendar in the When row", () => {
    // Answering is the one act that matters on the invite, so the RSVP button
    // takes the guest site's call-to-action shape and comes first; Add to
    // calendar is a quiet text action beside the date it acts on.
    const onRsvp = vi.fn();
    const { getByRole, container } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={onRsvp} />
    ));

    const rsvp = getByRole("button", { name: "RSVP for this event" });
    expect(rsvp.className).toContain("base:border-ui-accent");
    expect(rsvp.className).toContain("base:hover:bg-ui-accent");
    expect(container.querySelector("button, a[href]")).toBe(rsvp);

    const calendar = getByRole("button", { name: "Add to calendar" });
    expect(calendar.className).not.toContain("bg-gold");
    expect(calendar.closest("dd")?.previousElementSibling?.textContent).toBe("When");

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
    // A household with no reply hears where a reply can still go.
    expect(getByRole("status").textContent).toBe(
      "RSVPs closed on Sunday 1 September 2999. To reply now, please contact the couple directly.",
    );
  });

  it("draws the closed line in the closed treatment every other closed notice uses", () => {
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} rsvpClosed rsvpClosedOn="1 Sept" />
    ));
    const line = getByRole("status").querySelector("p")!;
    for (const cls of [
      "border",
      "border-border",
      "text-text-muted",
      "rounded-sm",
      "px-4",
      "py-3",
    ]) {
      expect(line.className.split(/\s+/)).toContain(cls);
    }
  });

  it("keeps the live region mounted, and empty, while replies are open", () => {
    const { getByRole } = renderPanel(baseEvent);
    expect(getByRole("status").textContent).toBe("");
  });

  it("offers a household that replied a way to view its RSVP after the deadline", () => {
    const onRsvp = vi.fn();
    const { getByRole, queryByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        onRsvp={onRsvp}
        rsvpClosed
        replied
        rsvpClosedOn="Sunday 1 September 2999"
      />
    ));

    expect(queryByRole("button", { name: "RSVP for this event" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "View your RSVP" }));
    expect(onRsvp).toHaveBeenCalledTimes(1);
    // The closed line still says when replies shut, and where a change goes.
    expect(getByRole("status").textContent).toBe(
      "RSVPs closed on Sunday 1 September 2999. To change your household's reply, please contact the couple directly.",
    );
  });

  it("offers no way in after the deadline to a household that never replied", () => {
    const { queryByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={() => {}} rsvpClosed />
    ));
    expect(queryByRole("button", { name: "View your RSVP" })).toBeNull();
    expect(queryByRole("button", { name: "RSVP for this event" })).toBeNull();
  });

  it("keeps focus on the button when the deadline relabels it for a household that replied", () => {
    const [closed, setClosed] = createSignal(false);
    const { getByRole } = render(() => (
      <DetailsPanel
        event={baseEvent}
        siteUrl={SITE_URL}
        onRsvp={() => {}}
        replied
        rsvpClosed={closed()}
      />
    ));
    const button = getByRole("button", { name: "RSVP for this event" });
    button.focus();

    setClosed(true);

    // The same control, renamed: focus stays where the guest left it.
    expect(button.textContent).toContain("View your RSVP");
    expect(document.activeElement).toBe(button);
  });

  it("says the replies have closed without a date when it has none", () => {
    const { getByRole } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} onRsvp={() => {}} rsvpClosed />
    ));
    expect(getByRole("status").textContent).toBe(
      "RSVPs have closed. To reply now, please contact the couple directly.",
    );
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

describe("DetailsPanel — the guest's own time", () => {
  afterEach(() => {
    cleanup();
    guestZone.value = "Australia/Sydney";
  });

  it("adds the guest's own time when their clock reads differently", () => {
    guestZone.value = "Europe/London";
    const { getByText } = renderPanel(baseEvent);
    expect(getByText(/^Your time: Fri 7:00\s*am – 1:00\s*pm \((BST|GMT\+1)\)$/)).toBeTruthy();
  });

  it("says nothing more where the guest's clock reads the same", () => {
    guestZone.value = "Australia/Melbourne";
    const { queryByText } = renderPanel(baseEvent);
    expect(queryByText(/Your time/)).toBeNull();
  });

  it("says nothing more where the browser names no zone", () => {
    guestZone.value = "";
    const { queryByText } = renderPanel(baseEvent);
    expect(queryByText(/Your time/)).toBeNull();
  });
});

describe("DetailsPanel — who's invited", () => {
  afterEach(() => cleanup());

  const member = (firstName: string, eventIds: string[], extra: Partial<FamilyMember> = {}) => ({
    guestId: `g-${firstName}`,
    firstName,
    lastName: "Lee",
    nickname: null,
    eventIds,
    ...extra,
  });

  it("names who is invited when not everyone the couple invited is", () => {
    const members = [member("Ana", [baseEvent.id]), member("Ben", [])];
    const { getByText, container } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} members={members} />
    ));
    const terms = [...container.querySelectorAll("dl > div > dt")].map((dt) => dt.textContent);
    expect(terms).toContain("Who's invited");
    const line = getByText("Ana", { exact: false });
    expect(line.textContent).toBe("Invited: Ana");
    // The visible prefix repeats the term, so a screen reader skips it.
    expect(line.querySelector("[aria-hidden='true']")?.textContent).toBe("Invited: ");
  });

  it("has no row when the whole household is invited", () => {
    const members = [member("Ana", [baseEvent.id]), member("Ben", [baseEvent.id])];
    const { queryByText } = render(() => (
      <DetailsPanel event={baseEvent} siteUrl={SITE_URL} members={members} />
    ));
    expect(queryByText("Who's invited")).toBeNull();
  });

  it("has no row without a household", () => {
    const { queryByText } = renderPanel(baseEvent);
    expect(queryByText("Who's invited")).toBeNull();
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
    // What stands in for them: the CSS map card naming the venue, and the
    // moodboard's own placeholder and link-out.
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

    // And no permission notice standing in for either of them.
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
    // Refusing costs the rich embeds and nothing else: the CSS map card still
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
