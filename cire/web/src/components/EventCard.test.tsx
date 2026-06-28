import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach } from "vitest";

import { EventCard } from "./EventCard";
import type { EventSummary } from "./types";

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

const withImage: EventSummary = {
  ...baseEvent,
  imageUrl: "/api/invite/cire-wedding/event/9f7a2c14-1b3d-4e5f-8a01-000000000001/image?v=abc123",
};

const noop = () => {};

describe("EventCard", () => {
  afterEach(() => cleanup());

  it("renders the event name, day (from startAt), venue (from address), description and BOTH buttons (Respond first)", () => {
    const { getByRole, container } = render(() => (
      <EventCard event={baseEvent} onRespond={noop} onDetails={noop} />
    ));
    expect(getByRole("heading", { name: "Mehndi" })).toBeTruthy();
    // The day is derived from startAt/timezone (no deprecated `date` field).
    expect(container.textContent).toContain("18 September 2026");
    // The venue is the canonical `address` (no deprecated `location` field).
    expect(container.textContent).toContain("12 Banksia Lane, Strathfield");
    expect(container.textContent).toContain("An evening of henna");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Respond", "View Event"]);
  });

  it("omits the venue line entirely when the event has no address", () => {
    const noAddress: EventSummary = { ...baseEvent, address: null };
    const { container } = render(() => (
      <EventCard event={noAddress} onRespond={noop} onDetails={noop} />
    ));
    // Day still renders from startAt; the venue paragraph is simply absent.
    expect(container.textContent).toContain("18 September 2026");
    expect(container.textContent).not.toContain("12 Banksia Lane");
  });

  it("collapses to a single text-only column when there is no image", () => {
    const { container } = render(() => (
      <EventCard event={baseEvent} apiUrl="https://api.test" onRespond={noop} onDetails={noop} />
    ));
    // No <img> rendered at all — no empty image half.
    expect(container.querySelector("img")).toBeNull();
    const grid = container.querySelector("[data-has-image]") as HTMLElement;
    expect(grid.dataset.hasImage).toBe("false");
  });

  it("renders the image (prepended with the API origin + responsive srcset) when present", () => {
    const { container } = render(() => (
      <EventCard
        event={withImage}
        apiUrl="https://api.test"
        orientation="norm"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    // The relative path is prefixed with the API origin.
    expect(img.getAttribute("src")).toBe(`https://api.test${withImage.imageUrl}`);
    // Responsive srcset uses the bounded thumb/card variants.
    const srcset = img.getAttribute("srcset") ?? "";
    expect(srcset).toContain("variant=thumb 320w");
    expect(srcset).toContain("variant=card 800w");
  });

  it("treats the image as absent when no API origin is provided (text-only)", () => {
    const { container } = render(() => (
      <EventCard event={withImage} orientation="norm" onRespond={noop} onDetails={noop} />
    ));
    expect(container.querySelector("img")).toBeNull();
  });

  it("orders text-left / image-right for the `norm` orientation", () => {
    const { container } = render(() => (
      <EventCard
        event={withImage}
        apiUrl="https://api.test"
        orientation="norm"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const grid = container.querySelector("[data-orientation]") as HTMLElement;
    expect(grid.dataset.orientation).toBe("norm");
    // Text column is order-1, image is order-2 on md+ (text left, image right).
    const textCol = grid.firstElementChild as HTMLElement;
    expect(textCol.className).toContain("md:order-1");
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.className).toContain("md:order-2");
  });

  it("renders the cropped region as a UNIFORMLY-scaled background div when a crop is set", () => {
    const cropped: EventSummary = { ...withImage, imageCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } };
    const { container } = render(() => (
      <EventCard
        event={cropped}
        apiUrl="https://api.test"
        orientation="norm"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    // No <img> for the cropped path — the region is a background div instead.
    expect(container.querySelector("img")).toBeNull();
    const region = container.querySelector('[role="img"]') as HTMLElement;
    expect(region).not.toBeNull();
    // The centred half-frame crop maps to a SINGLE-value 200% size (uniform — the
    // old two-value "200% 200%" stretched non-square crops) at 50% position.
    expect(region.style.backgroundSize.replace(/\.0+%/g, "%")).toBe("200%");
    expect(region.style.backgroundPosition.replace(/\.0+%/g, "%")).toBe("50% 50%");
    // Orientation ordering still applies to the cropped box.
    expect(region.className).toContain("md:order-2");
  });

  it("gives the cropped box the crop's true pixel aspect (no distortion, no letterbox)", () => {
    // A 0.5×0.5 crop fraction on a 4000×2000 image is a 2:1 pixel rectangle, so the
    // box must be 2:1 — not the default 4:3 — so the uniform render fills it exactly.
    const cropped: EventSummary = {
      ...withImage,
      imageCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, natW: 4000, natH: 2000 },
    };
    const { container } = render(() => (
      <EventCard event={cropped} apiUrl="https://api.test" onRespond={noop} onDetails={noop} />
    ));
    const region = container.querySelector('[role="img"]') as HTMLElement;
    expect(region).not.toBeNull();
    expect(Number.parseFloat(region.style.aspectRatio)).toBeCloseTo(2);
  });

  it("falls back to the default 4:3 box for a legacy crop without source dims", () => {
    const cropped: EventSummary = {
      ...withImage,
      imageCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    };
    const { container } = render(() => (
      <EventCard event={cropped} apiUrl="https://api.test" onRespond={noop} onDetails={noop} />
    ));
    const region = container.querySelector('[role="img"]') as HTMLElement;
    expect(Number.parseFloat(region.style.aspectRatio)).toBeCloseTo(4 / 3);
  });

  it("falls back to the plain <img> when the crop is the identity (full frame)", () => {
    const full: EventSummary = { ...withImage, imageCrop: { x: 0, y: 0, w: 1, h: 1 } };
    const { container } = render(() => (
      <EventCard event={full} apiUrl="https://api.test" onRespond={noop} onDetails={noop} />
    ));
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("flips to image-left / text-right for the `alt` orientation (DOM order unchanged)", () => {
    const { container } = render(() => (
      <EventCard
        event={withImage}
        apiUrl="https://api.test"
        orientation="alt"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const grid = container.querySelector("[data-orientation]") as HTMLElement;
    expect(grid.dataset.orientation).toBe("alt");
    // DOM order stays text-first (accessible); CSS order swaps the visual sides.
    const textCol = grid.firstElementChild as HTMLElement;
    expect(textCol.querySelector("h3")?.textContent).toBe("Mehndi");
    expect(textCol.className).toContain("md:order-2");
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.className).toContain("md:order-1");
  });
});
