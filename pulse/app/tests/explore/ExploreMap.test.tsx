import { fireEvent, render, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { describe, it, expect, afterEach } from "vitest";

import { ExploreMap } from "../../src/explore/ExploreMap";
import type { VenueSummary } from "../../src/lib/venues";
import { wrapRouter } from "../helpers/router";

const venueRow = (overrides: Partial<VenueSummary>): VenueSummary => ({
  id: "ven_x",
  orgHandle: "org",
  handle: "venue",
  name: "Some Venue",
  kind: "club",
  description: null,
  address: null,
  city: null,
  country: null,
  latitude: null,
  longitude: null,
  capacity: null,
  hours: null,
  heroImageUrl: null,
  websiteUrl: null,
  instagramHandle: null,
  timezone: "UTC",
  ...overrides,
});

const renderWithRouter = (factory: () => JSX.Element) => render(() => wrapRouter(factory));

const eventsWithGeo = [
  {
    id: "evt_1",
    title: "Jazz Night",
    status: "upcoming" as const,
    startTime: "2030-06-01T19:30:00.000Z",
    category: "music",
    venue: "The Vessel",
    latitude: 40.725,
    longitude: -73.985,
  },
  {
    id: "evt_2",
    title: "Ceramics Studio",
    status: "upcoming" as const,
    startTime: "2030-06-01T18:00:00.000Z",
    category: "art",
    venue: "Clayroom",
    latitude: 40.676,
    longitude: -73.988,
  },
];

const eventNoGeo = {
  id: "evt_3",
  title: "Online Talk",
  status: "upcoming" as const,
  startTime: "2030-06-01T20:00:00.000Z",
  category: "talks",
};

describe("ExploreMap", () => {
  afterEach(cleanup);

  it("renders the map wrapper", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders SVG base map", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders a canvas for heatmap overlay", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
  });

  it("renders event pins for events with coordinates", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    // Each pin has an SVG with a pin path
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(2);
  });

  it("does not render pins for events without coordinates", () => {
    const { container } = render(() => <ExploreMap events={[eventNoGeo]} />);
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(0);
  });

  it("renders time scrubber with 'HEAT AT' label", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("HEAT AT")).toBeTruthy();
  });

  it("renders time scrubber range input", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const slider = container.querySelector("input[type='range']") as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("23");
  });

  it("renders time tick labels", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("12AM")).toBeTruthy();
    expect(getByText("NOON")).toBeTruthy();
    expect(getByText("11PM")).toBeTruthy();
  });

  it("renders legend with heat scale labels", () => {
    const { getByText } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(getByText("Heat · people here")).toBeTruthy();
    expect(getByText("quiet")).toBeTruthy();
    expect(getByText("bustling")).toBeTruthy();
    expect(getByText("packed")).toBeTruthy();
  });

  it("renders zoom/layer control buttons", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    expect(container.querySelector("[title='Zoom in']")).toBeTruthy();
    expect(container.querySelector("[title='Layers']")).toBeTruthy();
  });

  it("renders neighborhood labels in SVG", () => {
    const { container } = render(() => <ExploreMap events={eventsWithGeo} />);
    const texts = Array.from(container.querySelectorAll("svg text"));
    const labels = texts.map((t) => t.textContent);
    expect(labels).toContain("WILLIAMSBURG");
    expect(labels).toContain("PROSPECT PARK");
    expect(labels).toContain("PARK SLOPE");
    expect(labels).toContain("BED–STUY");
  });

  it("mixes geo and non-geo events — only pins for geo events", () => {
    const mixed = [...eventsWithGeo, eventNoGeo];
    const { container } = render(() => <ExploreMap events={mixed} />);
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(2);
  });

  it("renders with empty event list without crashing", () => {
    const { container } = render(() => <ExploreMap events={[]} />);
    expect(container.querySelector("svg")).toBeTruthy(); // base map still renders
    const pinSvgs = container.querySelectorAll("svg[viewBox='0 0 34 42']");
    expect(pinSvgs.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Venue layer (T-R1)
  // -------------------------------------------------------------------------

  it("renders a clickable venue pin for venues inside the bbox", () => {
    const venues = [
      venueRow({
        id: "ven_1",
        orgHandle: "tpf",
        handle: "factory",
        latitude: 40.705,
        longitude: -73.93,
      }),
    ];
    const { container } = renderWithRouter(() => <ExploreMap events={[]} venues={venues} />);
    const links = container.querySelectorAll<HTMLAnchorElement>("a[href='/venues/tpf/factory']");
    expect(links.length).toBe(1);
  });

  it("filters venues outside the NYC bbox", () => {
    const venues = [
      venueRow({
        id: "ven_london",
        orgHandle: "tpf",
        handle: "london",
        // London is well outside the NYC bbox.
        latitude: 51.5326,
        longitude: -0.0561,
      }),
    ];
    const { container } = renderWithRouter(() => <ExploreMap events={[]} venues={venues} />);
    expect(container.querySelectorAll("a[href^='/venues/']").length).toBe(0);
  });

  it("hides the venue pin when an event pin sits at the same venue", () => {
    const venues = [
      venueRow({
        id: "ven_dup",
        orgHandle: "tpf",
        handle: "factory",
        latitude: 40.705,
        longitude: -73.93,
      }),
    ];
    const events = [
      {
        id: "evt_at_venue",
        title: "Friday Residency",
        status: "upcoming" as const,
        startTime: "2030-06-07T22:00:00.000Z",
        category: "music",
        venue: "The Factory",
        venueId: "ven_dup",
        latitude: 40.705,
        longitude: -73.93,
      },
    ];
    const { container } = renderWithRouter(() => <ExploreMap events={events} venues={venues} />);
    // No standalone venue diamond — event pin owns the location.
    expect(container.querySelectorAll("a[href^='/venues/']").length).toBe(0);
  });

  it("surfaces a 'See venue' link in the popover on event-pin hover when venueId resolves", async () => {
    const venues = [
      venueRow({
        id: "ven_dup",
        orgHandle: "tpf",
        handle: "factory",
        latitude: 40.705,
        longitude: -73.93,
      }),
    ];
    const events = [
      {
        id: "evt_at_venue",
        title: "Friday Residency",
        status: "upcoming" as const,
        startTime: "2030-06-07T22:00:00.000Z",
        category: "music",
        venue: "The Factory",
        venueId: "ven_dup",
        latitude: 40.705,
        longitude: -73.93,
      },
    ];
    const { container, findByText } = renderWithRouter(() => (
      <ExploreMap events={events} venues={venues} />
    ));
    // EventPin renders <div><svg>; the outer positioned <button> with
    // the onMouseEnter handler is one level above that inner wrapper.
    const innerPinDiv = container
      .querySelector("svg[viewBox='0 0 34 42']")
      ?.closest("div") as HTMLElement;
    const pinWrapper = innerPinDiv.parentElement as HTMLElement;
    fireEvent.mouseEnter(pinWrapper);
    const link = (await findByText(/See venue/i)) as HTMLElement;
    const anchor = link.tagName === "A" ? link : link.closest("a");
    expect(anchor?.getAttribute("href")).toBe("/venues/tpf/factory");
  });

  // -------------------------------------------------------------------------
  // Keyboard access to the event-pin popover (C-M2 / WCAG 2.1.1)
  // -------------------------------------------------------------------------

  const coLocatedFixtures = () => ({
    venues: [
      venueRow({
        id: "ven_dup",
        orgHandle: "tpf",
        handle: "factory",
        latitude: 40.705,
        longitude: -73.93,
      }),
    ],
    events: [
      {
        id: "evt_at_venue",
        title: "Friday Residency",
        status: "upcoming" as const,
        startTime: "2030-06-07T22:00:00.000Z",
        category: "music",
        venue: "The Factory",
        venueId: "ven_dup",
        latitude: 40.705,
        longitude: -73.93,
      },
    ],
  });

  it("renders event pins as focusable buttons labelled with the event title", () => {
    const { venues, events } = coLocatedFixtures();
    const { container } = renderWithRouter(() => <ExploreMap events={events} venues={venues} />);
    const pin = container.querySelector("button[aria-label='Friday Residency']");
    expect(pin).toBeTruthy();
  });

  it("opens the popover with the 'See venue' link on focus", async () => {
    const { venues, events } = coLocatedFixtures();
    const { container, findByText } = renderWithRouter(() => (
      <ExploreMap events={events} venues={venues} />
    ));
    const pin = container.querySelector(
      "button[aria-label='Friday Residency']",
    ) as HTMLButtonElement;
    fireEvent.focus(pin);
    const link = (await findByText(/See venue/i)) as HTMLElement;
    const anchor = link.tagName === "A" ? link : link.closest("a");
    expect(anchor?.getAttribute("href")).toBe("/venues/tpf/factory");
  });

  it("dismisses the popover on Escape", async () => {
    const { venues, events } = coLocatedFixtures();
    const { container, findByText, queryByText } = renderWithRouter(() => (
      <ExploreMap events={events} venues={venues} />
    ));
    const pin = container.querySelector(
      "button[aria-label='Friday Residency']",
    ) as HTMLButtonElement;
    fireEvent.focus(pin);
    await findByText(/See venue/i);
    fireEvent.keyDown(pin, { key: "Escape" });
    expect(queryByText(/See venue/i)).toBeNull();
  });
});
