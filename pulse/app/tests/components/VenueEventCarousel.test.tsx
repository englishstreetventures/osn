// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { VenueEventCarousel } from "../../src/components/VenueEventCarousel";
import type { VenueEvent } from "../../src/lib/venues";
import { wrapRouter } from "../helpers/router";

const renderWithRouter = (factory: () => JSX.Element) => render(() => wrapRouter(factory));

const evt = (overrides: Partial<VenueEvent>): VenueEvent => ({
  id: "evt_1",
  title: "Friday Residency",
  description: null,
  startTime: "2030-06-07T22:00:00.000Z",
  endTime: "2030-06-08T05:00:00.000Z",
  status: "upcoming",
  imageUrl: null,
  category: "nightlife",
  priceAmount: 1500,
  priceCurrency: "GBP",
  venueId: "ven_pf",
  createdByName: null,
  ...overrides,
});

describe("VenueEventCarousel", () => {
  afterEach(cleanup);

  it("renders the empty-state copy when there are no events", () => {
    const { getByText } = renderWithRouter(() => <VenueEventCarousel events={[]} />);
    expect(getByText(/No upcoming events programmed/i)).toBeTruthy();
  });

  it("renders each event card with a link to its detail page", () => {
    const { getAllByRole } = renderWithRouter(() => (
      <VenueEventCarousel
        events={[evt({ id: "evt_a", title: "Card A" }), evt({ id: "evt_b", title: "Card B" })]}
      />
    ));
    const links = getAllByRole("link").filter((a) =>
      a.getAttribute("href")?.startsWith("/events/"),
    );
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/events/evt_a", "/events/evt_b"]);
  });

  it("renders the heading when provided", () => {
    const { getByText } = renderWithRouter(() => (
      <VenueEventCarousel events={[evt({})]} heading="Upcoming at The Spot" />
    ));
    expect(getByText("Upcoming at The Spot")).toBeTruthy();
  });

  it("hides the prev/next chevrons when the carousel does not need scrolling", () => {
    // jsdom-style envs report scrollWidth === clientWidth === 0, so the
    // needsScroll signal stays false on a freshly-mounted carousel —
    // exactly the condition under which the chevrons should hide.
    const { queryByLabelText } = renderWithRouter(() => (
      <VenueEventCarousel events={[evt({})]} heading="Programme" />
    ));
    expect(queryByLabelText(/Scroll programme left/i)).toBeNull();
    expect(queryByLabelText(/Scroll programme right/i)).toBeNull();
  });
});
