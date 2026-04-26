import { render as _baseRender, cleanup } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { ExploreCard } from "../../src/explore/ExploreCard";
import { wrapRouter } from "../helpers/router";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

const baseEvent = {
  id: "evt_1",
  title: "Rooftop Jazz Session",
  status: "upcoming" as const,
  startTime: "2030-06-01T19:30:00.000Z",
  category: "music",
  venue: "The Vessel",
  location: "East Village",
  createdByProfileId: "usr_host",
  createdByName: "Maya Chen",
};

describe("ExploreCard", () => {
  afterEach(cleanup);

  it("renders event title", () => {
    const { getByText } = render(() => <ExploreCard event={baseEvent} />);
    expect(getByText("Rooftop Jazz Session")).toBeTruthy();
  });

  it("renders venue and location", () => {
    const { getByText } = render(() => <ExploreCard event={baseEvent} />);
    expect(getByText("The Vessel")).toBeTruthy();
    expect(getByText("East Village")).toBeTruthy();
  });

  it("renders host name with 'Hosted by' prefix", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const body = container.textContent ?? "";
    expect(body).toContain("Hosted by");
    expect(body).toContain("Maya Chen");
  });

  it("renders host initials as avatar fallback", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const avatarFallback = container.querySelector("span.base\\:relative");
    expect(avatarFallback?.textContent).toBe("MC");
  });

  it("omits host row when createdByName is absent", () => {
    const event = { ...baseEvent, createdByName: undefined };
    const { container } = render(() => <ExploreCard event={event} />);
    expect(container.textContent).not.toContain("Hosted by");
  });

  it("renders date stamp with month, day, and weekday", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const dateStamp = container.querySelector(".date-stamp");
    expect(dateStamp).toBeTruthy();
    // Timezone-agnostic: just verify structure exists (month, day number, weekday)
    const text = dateStamp!.textContent ?? "";
    expect(text).toMatch(/JUN|MAY/); // June (or May if TZ offset crosses midnight)
    expect(text).toMatch(/\d+/); // day number
    expect(text).toMatch(/MON|TUE|WED|THU|FRI|SAT|SUN/); // weekday
  });

  it("renders formatted time in meta line", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const metaLine = container.querySelector("[style*='font-mono']");
    // Timezone-agnostic: verify time format exists (H:MM AM/PM)
    expect(metaLine?.textContent).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });

  it("renders category in card footer", () => {
    const { getByText } = render(() => <ExploreCard event={baseEvent} />);
    expect(getByText("music")).toBeTruthy();
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

  it("renders image when imageUrl provided", () => {
    const event = { ...baseEvent, imageUrl: "https://example.com/event.jpg" };
    const { container } = render(() => <ExploreCard event={event} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://example.com/event.jpg");
  });

  it("uses category-specific gradient class", () => {
    const artEvent = { ...baseEvent, category: "art" };
    const { container } = render(() => <ExploreCard event={artEvent} />);
    expect(container.querySelector(".ph-2")).toBeTruthy();

    cleanup();

    const foodEvent = { ...baseEvent, category: "food" };
    const { container: c2 } = render(() => <ExploreCard event={foodEvent} />);
    expect(c2.querySelector(".ph-5")).toBeTruthy();
  });

  it("falls back to ph-4 for unknown category", () => {
    const event = { ...baseEvent, category: "unknown" };
    const { container } = render(() => <ExploreCard event={event} />);
    expect(container.querySelector(".ph-4")).toBeTruthy();
  });

  it("renders as a link to event detail page", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBe("/events/evt_1");
  });

  it("applies featured layout class when featured prop is true", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} featured />);
    const card = container.querySelector("a");
    expect(card!.classList.contains("grid-cols-1")).toBe(true);
  });

  it("applies two-column layout when not featured", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const card = container.querySelector("a");
    expect(card!.classList.contains("grid-cols-[180px_1fr]")).toBe(true);
  });

  it("applies hover border style when hovered prop is true", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} hovered />);
    const card = container.querySelector("a") as HTMLElement;
    expect(card.style.borderColor).toBe("var(--foreground)");
  });

  it("calls mouse event handlers", () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { container } = render(() => (
      <ExploreCard event={baseEvent} onMouseEnter={onEnter} onMouseLeave={onLeave} />
    ));
    const card = container.querySelector("a")!;
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(onEnter).toHaveBeenCalled();
    card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(onLeave).toHaveBeenCalled();
  });

  it("renders category glyph in placeholder", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    // Music category → glyph ☼
    const glyph = container.querySelector("[style*='font-serif']");
    expect(glyph?.textContent).toBe("☼");
  });

  it("separator dot appears between venue and location", () => {
    const { container } = render(() => <ExploreCard event={baseEvent} />);
    const dots = container.querySelectorAll(".rounded-full.bg-foreground\\/20");
    expect(dots.length).toBe(1);
  });

  it("omits separator dot when only venue or only location", () => {
    const venueOnly = { ...baseEvent, location: undefined };
    const { container } = render(() => <ExploreCard event={venueOnly} />);
    const dots = container.querySelectorAll(".rounded-full.bg-foreground\\/20");
    expect(dots.length).toBe(0);
  });
});
