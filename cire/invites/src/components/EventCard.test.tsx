import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { batch, createSignal } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { EventCard } from "./EventCard";
import { HOLD_MS, TICK_DELAY_MS, TOTAL_DURATION_MS } from "./rsvp-responded";
import type { EventSummary } from "./types";

function respondButton(container: HTMLElement) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond" || b.textContent === "RSVPs closed",
  ) as HTMLButtonElement;
}

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
    expect(buttons.map((b) => b.textContent)).toEqual(["Respond", "Event Details"]);
  });

  it("paints the date in the prose gold, not the metal (C-M2 / WCAG 1.4.3)", () => {
    const { getByText } = render(() => (
      <EventCard event={baseEvent} onRespond={noop} onDetails={noop} />
    ));
    // 0.92rem is normal-size text (4.5:1), and the card sits on
    // `--color-surface-raised` — the surface `--color-gold` is never walked
    // against. That combination shipped the date at 3.58:1 on the `chapel`
    // preset and 3.91:1 on `garden`. `--color-gold-ink` is enforced at the
    // text minimum against all three surfaces, this one included.
    const classes = getByText(/18 September 2026/).className.split(/\s+/);
    expect(classes).toContain("text-gold-ink");
    expect(classes).not.toContain("text-gold");
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

  it("offers Respond while RSVPs are open", () => {
    const { getByRole } = render(() => (
      <EventCard event={baseEvent} onRespond={noop} onDetails={noop} />
    ));
    const respond = getByRole("button", { name: "Respond" }) as HTMLButtonElement;
    expect(respond.disabled).toBe(false);
  });

  it("locks Respond once the RSVP deadline has passed", () => {
    const onRespond = vi.fn();
    const { getByRole, queryByRole } = render(() => (
      <EventCard event={baseEvent} rsvpClosed onRespond={onRespond} onDetails={noop} />
    ));

    // Relabelled rather than removed — a vanished button reads as a broken
    // invite; this says what happened.
    expect(queryByRole("button", { name: "Respond" })).toBeNull();
    const closed = getByRole("button", { name: "RSVPs closed" }) as HTMLButtonElement;
    expect(closed.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(closed);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("keeps the closed button focusable and described by the notice (C-M2)", () => {
    const { getByRole } = render(() => (
      <EventCard
        event={baseEvent}
        rsvpClosed
        rsvpClosedNoticeId="rsvp-deadline-notice"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const closed = getByRole("button", { name: "RSVPs closed" }) as HTMLButtonElement;

    // The native attribute would take it out of the tab order, making the one
    // per-card explanation of why the action is gone unreachable by keyboard —
    // and would drop focus to <body> if the deadline passed while it was
    // focused. `aria-disabled` says the same thing and stays reachable.
    expect(closed.hasAttribute("disabled")).toBe(false);
    expect(closed.getAttribute("aria-disabled")).toBe("true");
    expect(closed.getAttribute("aria-describedby")).toBe("rsvp-deadline-notice");

    closed.focus();
    expect(document.activeElement).toBe(closed);
  });

  it("carries no aria-disabled or describedby while RSVPs are open", () => {
    const { getByRole } = render(() => (
      <EventCard
        event={baseEvent}
        rsvpClosedNoticeId="rsvp-deadline-notice"
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const respond = getByRole("button", { name: "Respond" });
    expect(respond.hasAttribute("aria-disabled")).toBe(false);
    // A describedby pointing at a notice that isn't rendered would be a
    // dangling reference; the open state must not set one.
    expect(respond.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps Event Details reachable after the deadline (only the answer locks)", () => {
    const onDetails = vi.fn();
    const { getByRole } = render(() => (
      <EventCard event={baseEvent} rsvpClosed onRespond={noop} onDetails={onDetails} />
    ));
    fireEvent.click(getByRole("button", { name: "Event Details" }));
    expect(onDetails).toHaveBeenCalledWith(baseEvent);
  });

  describe("recorded-reply confirmation", () => {
    /**
     * The confirmation PR #380 shipped on the RSVP sheet's Save button — a
     * fill sweep and a drawn tick — moved here (`rsvp-responded.ts`): first as
     * the same flourish on Respond, then settling into a permanent bloom fill
     * and tick that stay once the sweep-in has played (no fade-out). happy-dom
     * computes no CSS, so these pin the contract the visuals hang off — which
     * classes are present, when — not what a guest actually sees. The
     * durations themselves are guarded in `rsvp-responded.test.ts`.
     */

    it("shows no tick at all before any reply is recorded", () => {
      const { container } = render(() => (
        <EventCard event={baseEvent} onRespond={noop} onDetails={noop} />
      ));
      // A tick on an event nobody has answered would claim a reply that was
      // never sent.
      expect(respondButton(container).querySelector("svg")).toBeNull();
    });

    it("shows a permanent bloom fill and tick when responded, with no draw animation", () => {
      const { container } = render(() => (
        <EventCard event={baseEvent} responded onRespond={noop} onDetails={noop} />
      ));
      const button = respondButton(container);
      const fill = button.querySelector("span[aria-hidden='true']") as HTMLElement;
      // A reload of an already-answered event renders already filled — the
      // `filled` signal latches to `responded`'s value at mount.
      expect(fill.className).toContain("scale-x-100");
      const path = button.querySelector("svg path") as SVGPathElement;
      expect(path).toBeTruthy();
      // Loaded already-answered, not just-drawn: no dash trick, no keyframe.
      expect(path.hasAttribute("stroke-dasharray")).toBe(false);
      expect(path.getAttribute("class") ?? "").not.toContain("animate-tick-draw");
      const svg = path.closest("svg") as SVGElement;
      // Sitting on the permanent fill, the tick uses the on-fill ink.
      expect(svg.getAttribute("class")).toContain("text-bg");
      expect(svg.getAttribute("class")).not.toContain("text-bloom");
    });

    it("renders the tick after the Respond label, not before it", () => {
      // `textContent` and `querySelector` checks elsewhere in this file can't
      // distinguish tick-before-label from tick-after-label — the <svg>
      // contributes no text, so a DOM-order check is the one assertion shape
      // that actually catches a silent revert of the two swapping back.
      const { container } = render(() => (
        <EventCard event={baseEvent} responded onRespond={noop} onDetails={noop} />
      ));
      const button = respondButton(container);
      const label = button.querySelector("span.relative") as HTMLElement;
      const svg = label.querySelector("svg") as SVGElement;
      const textNode = [...label.childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === "Respond",
      );
      expect(textNode).toBeTruthy();
      expect(
        Boolean(textNode!.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
    });

    it("mounts the fill collapsed from the start, so the sweep has a frame to travel from", () => {
      const { container } = render(() => (
        <EventCard event={baseEvent} onRespond={noop} onDetails={noop} />
      ));
      const button = respondButton(container);
      const fill = button.querySelector("span[aria-hidden='true']") as HTMLElement;
      expect(fill).toBeTruthy();
      expect(fill.className).toContain("scale-x-0");
      expect(fill.className).toContain("bg-bloom");
      expect(fill.className).toContain("transition-transform");
      // The fill is a sweep OVER the button, not a replacement of its base
      // colour — `bg-gold` (and the rest of the open-state classes) must
      // still be on the button itself, not renamed alongside the accent swap.
      expect(button.className).toContain("bg-gold");
      expect(button.className).not.toContain("bg-bloom");
    });

    it("does not celebrate on mount even if justResponded starts true", () => {
      // The parent never actually does this — `justResponded` only ever
      // flips true from a live confirmation — but the guard is the same one
      // `responded` follows, and must hold here too: only a fresh transition
      // celebrates.
      const { container } = render(() => (
        <EventCard event={baseEvent} justResponded onRespond={noop} onDetails={noop} />
      ));
      expect(respondButton(container).querySelector("svg")).toBeNull();
    });

    it("plays the sweep-in/hold choreography once justResponded flips true, settling on a permanent fill and tick", async () => {
      vi.useFakeTimers();
      try {
        const onCelebrated = vi.fn();
        const [responded, setResponded] = createSignal(false);
        const [justResponded, setJustResponded] = createSignal(false);
        const { container } = render(() => (
          <EventCard
            event={baseEvent}
            responded={responded()}
            justResponded={justResponded()}
            onCelebrated={onCelebrated}
            onRespond={noop}
            onDetails={noop}
          />
        ));
        const button = respondButton(container);

        // Mirrors the real wiring: the parent's `claimResult` (driving
        // `responded`) and `justResponded` both flip inside the same
        // `RsvpModal` batch — see `onConfirmed`/`onSubmitted` there.
        batch(() => {
          setResponded(true);
          setJustResponded(true);
        });

        // Sweep-in: filled immediately, tick drawing.
        const fill = button.querySelector("span[aria-hidden='true']") as HTMLElement;
        expect(fill.className).toContain("scale-x-100");
        let path = button.querySelector("svg path") as SVGPathElement;
        expect(path.getAttribute("stroke-dasharray")).toBe("20");
        expect(path.getAttribute("class")).toContain("animate-tick-draw");
        let svg = path.closest("svg") as SVGElement;
        expect(svg.getAttribute("class")).toContain("text-bg");

        // Still holding, filled, part-way through the tick's own delay.
        await vi.advanceTimersByTimeAsync(TICK_DELAY_MS);
        expect(fill.className).toContain("scale-x-100");

        // Past the hold: no fade-out — the fill and the on-fill ink both
        // stay exactly as they were.
        await vi.advanceTimersByTimeAsync(HOLD_MS - TICK_DELAY_MS);
        expect(fill.className).toContain("scale-x-100");
        path = button.querySelector("svg path") as SVGPathElement;
        svg = path.closest("svg") as SVGElement;
        expect(svg.getAttribute("class")).toContain("text-bg");
        expect(onCelebrated).toHaveBeenCalledTimes(1);

        // Celebration over: the fill and tick stay, the tick now undrawn (no
        // dash trick), and the parent is told so it can arm the next
        // confirmation. `TOTAL_DURATION_MS` equals `HOLD_MS` now, so nothing
        // further changes past this point.
        path = button.querySelector("svg path") as SVGPathElement;
        expect(path).toBeTruthy();
        expect(path.hasAttribute("stroke-dasharray")).toBe(false);
        expect(fill.className).toContain("scale-x-100");
      } finally {
        vi.useRealTimers();
      }
    });

    it("restarts the choreography from the top when a re-submit lands mid-celebration", async () => {
      // Documented behaviour in `playCelebration`: an edited, re-submitted
      // reply arriving while the previous celebration is still fading must
      // restart from the sweep-in, not layer a second pair of timers over the
      // first (which would fire `onCelebrated` twice, once early).
      vi.useFakeTimers();
      try {
        const onCelebrated = vi.fn();
        const [justResponded, setJustResponded] = createSignal(false);
        const { container } = render(() => (
          <EventCard
            event={baseEvent}
            responded
            justResponded={justResponded()}
            onCelebrated={onCelebrated}
            onRespond={noop}
            onDetails={noop}
          />
        ));
        const button = respondButton(container);
        const fill = () => button.querySelector("span[aria-hidden='true']") as HTMLElement;

        setJustResponded(true);
        expect(fill().className).toContain("scale-x-100");

        // Well into the hold — mid-celebration, nowhere near the end.
        await vi.advanceTimersByTimeAsync(HOLD_MS / 2);
        expect(fill().className).toContain("scale-x-100");

        // The edited reply: a fresh false→true transition before the first
        // celebration has finished. NOT batched — in production these are two
        // separate calls at two separate times (`onCelebrated` resetting to
        // null, then a LATER `onConfirmed` setting it again), never one atomic
        // write the effect could coalesce away.
        setJustResponded(false);
        setJustResponded(true);
        expect(fill().className).toContain("scale-x-100");

        // If the restart failed to cancel the FIRST celebration's timers, the
        // original hold would have expired by now (HOLD_MS/2 + HOLD_MS/2) and
        // faded the fill despite the restart.
        await vi.advanceTimersByTimeAsync(HOLD_MS / 2);
        expect(fill().className).toContain("scale-x-100");

        // The restarted celebration completes on its OWN full timeline,
        // measured from the restart point (HOLD_MS/2 in) — exactly one
        // `onCelebrated`, not the original (already-elapsed) one.
        await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS - HOLD_MS / 2);
        expect(onCelebrated).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the permanent fill and tick visible on the closed, outlined RSVPs-closed button too", () => {
      // The tick, the fill and `rsvpClosed` gate independent parts of the
      // markup — a household that answered before the deadline should still
      // see their fill and tick after RSVPs shut, on the relabelled
      // secondary-styled button.
      const { container } = render(() => (
        <EventCard event={baseEvent} rsvpClosed responded onRespond={noop} onDetails={noop} />
      ));
      const button = respondButton(container);
      expect(button.textContent).toBe("RSVPs closed");
      const fill = button.querySelector("span[aria-hidden='true']") as HTMLElement;
      expect(fill.className).toContain("scale-x-100");
      const path = button.querySelector("svg path") as SVGPathElement;
      expect(path).toBeTruthy();
      expect(path.closest("svg")!.getAttribute("class")).toContain("text-bg");
    });

    it("clears its timers on unmount mid-celebration", async () => {
      // A surviving timer firing `onCelebrated` on a disposed instance is the
      // same class of bug `RsvpModal`'s dwell timer guards against.
      vi.useFakeTimers();
      try {
        const onCelebrated = vi.fn();
        const [justResponded, setJustResponded] = createSignal(false);
        const { unmount } = render(() => (
          <EventCard
            event={baseEvent}
            justResponded={justResponded()}
            onCelebrated={onCelebrated}
            onRespond={noop}
            onDetails={noop}
          />
        ));
        setJustResponded(true);
        unmount();
        await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS * 2);
        expect(onCelebrated).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
