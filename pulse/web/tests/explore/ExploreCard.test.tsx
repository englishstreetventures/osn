import { render as _baseRender, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { describe, it, expect, afterEach } from "vitest";

import { ExploreCard } from "../../src/explore/ExploreCard";
import { makeEvent } from "../helpers/events";
import { wrapRouter } from "../helpers/router";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

const baseEvent = makeEvent({
  id: "evt_1",
  title: "Rooftop Jazz Session",
  status: "upcoming",
  startTime: "2030-06-01T19:30:00.000Z",
  category: "music",
  venue: "The Vessel",
  location: "East Village",
  createdByProfileId: "usr_host",
  createdByName: "Maya Chen",
});

describe("ExploreCard", () => {
  afterEach(cleanup);

  it("omits host row when createdByName is absent", () => {
    const event = { ...baseEvent, createdByName: null };
    const { container } = render(() => <ExploreCard event={event} />);
    expect(container.textContent).not.toContain("Hosted by");
  });

  it("renders 'Part of …' series banner when series prop is provided", () => {
    const { container, getByText } = render(() => (
      <ExploreCard event={baseEvent} series={{ id: "series_yoga", title: "Sunrise Yoga" }} />
    ));
    expect(getByText("Part of Sunrise Yoga")).toBeTruthy();
    // Banner sits above the card; the inner <a> drops its top rounding
    // so the banner + card visually attach.
    const card = container.querySelector("a[href='/events/evt_1']");
    expect(card?.classList.contains("rounded-t-none")).toBe(true);
  });

  it("does not render the series banner when series prop is null/undefined", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} series={null} />);
    expect(container.textContent).not.toContain("Part of");
    const card = container.querySelector("a[href='/events/evt_1']");
    expect(card?.classList.contains("rounded-t-none")).toBe(false);
  });

  it("renders 'Happening now' tag for ongoing events", () => {
    const event = { ...baseEvent, status: "ongoing" as const };
    const { getByText } = render(() => <ExploreCard event={event} />);
    expect(getByText("Happening now")).toBeTruthy();
  });

  it("does not render 'Happening now' tag for upcoming events", () => {
    const { queryByText } = render(() => <ExploreCard event={baseEvent} />);
    expect(queryByText("Happening now")).toBeNull();
  });

  it("uses gradient placeholder when no imageUrl", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const media = container.querySelector(".ph-1");
    expect(media).toBeTruthy();
    const pattern = container.querySelector(".ph-pattern");
    expect(pattern).toBeTruthy();
  });

  it("falls back to ph-4 for unknown category", () => {
    const event = { ...baseEvent, category: "unknown" };
    const { container } = render(() => <ExploreCard event={event} />);
    expect(container.querySelector(".ph-4")).toBeTruthy();
  });

  it("separator dot appears between venue and location", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const dots = container.querySelectorAll(".rounded-full.bg-foreground\\/20");
    expect(dots.length).toBe(1);
  });

  it("omits separator dot when only venue or only location", () => {
    const venueOnly = { ...baseEvent, location: null };
    const { container } = render(() => <ExploreCard event={venueOnly} />);
    const dots = container.querySelectorAll(".rounded-full.bg-foreground\\/20");
    expect(dots.length).toBe(0);
  });
});
