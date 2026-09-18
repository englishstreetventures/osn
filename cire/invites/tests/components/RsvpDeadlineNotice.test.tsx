import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { RSVP_NOTICE_ID, type RsvpDeadlineState } from "../../src/components/rsvp-deadline";
import { RsvpDeadlineNotice } from "../../src/components/RsvpDeadlineNotice";
import type { RsvpDeadline } from "../../src/components/types";

/**
 * The deadline copy's own branches. The two design packs' InvitePage tests cover
 * PLACEMENT — which pack puts it where, and what the live region is wired to —
 * while this file covers the component: the three treatments, the two variants,
 * and the announce/id wiring that decides which of the two copies on a page is
 * the one a screen reader hears.
 */

const deadline: RsvpDeadline = {
  date: "2026-09-01",
  timezone: "Australia/Sydney",
  closesAt: "2026-09-01T13:59:59.999Z",
  closed: false,
};

afterEach(cleanup);

/** The rendered paragraph, or null when the component drew nothing. */
function notice(
  state: RsvpDeadlineState | null,
  over: { variant?: "notice" | "panel"; announce?: boolean; id?: string; class?: string } = {},
) {
  const { container } = render(() => (
    <RsvpDeadlineNotice
      deadline={deadline}
      state={state}
      variant={over.variant ?? "notice"}
      announce={over.announce}
      id={over.id}
      class={over.class}
    />
  ));
  return container.querySelector("p");
}

describe("RsvpDeadlineNotice", () => {
  it("draws nothing for a wedding with no deadline", () => {
    const { container } = render(() => (
      <RsvpDeadlineNotice deadline={null} state={null} variant="notice" />
    ));
    expect(container.querySelector("p")).toBeNull();
  });

  describe("treatments", () => {
    it("keeps the open state a plain line in the prose gold", () => {
      const classes = notice("open")!.className.split(/\s+/);
      expect(classes).toContain("text-gold-ink");
      // No box: the escalation has somewhere to go.
      expect(classes).not.toContain("border");
      // The metal is held to the 3:1 UI floor, which is the wrong bar for a
      // sentence at normal size (WCAG 1.4.3 asks 4.5:1).
      expect(classes).not.toContain("text-gold");
    });

    it("boxes the closing-soon state in the same prose gold", () => {
      const classes = notice("closing-soon")!.className.split(/\s+/);
      expect(classes).toContain("border");
      expect(classes).toContain("border-gold/40");
      expect(classes).toContain("text-gold-ink");
      expect(classes).not.toContain("text-gold");
    });

    it("boxes the closed state in the hairline and lets the ink recede", () => {
      const classes = notice("closed")!.className.split(/\s+/);
      expect(classes).toContain("border");
      expect(classes).toContain("border-border");
      expect(classes).toContain("text-text-muted");
      expect(classes).not.toContain("text-gold-ink");
    });

    it("washes nothing behind the text, in any state", () => {
      // The ink is walked to 4.5:1 against the section's own surfaces. A tint
      // between the two composites a backdrop nothing measures, which is how a
      // chip elsewhere in this repo shipped marked at under 2:1 with a green
      // suite.
      for (const state of ["open", "closing-soon", "closed"] as const) {
        const classes = notice(state)!.className.split(/\s+/);
        expect(classes.filter((c) => c.startsWith("bg-"))).toEqual([]);
      }
    });

    it("keeps the caller's placement classes alongside its own", () => {
      const classes = notice("open", { class: "mb-3 text-center" })!.className.split(/\s+/);
      expect(classes).toContain("text-center");
      expect(classes).toContain("mb-3");
      expect(classes).toContain("text-gold-ink");
    });
  });

  describe("copy", () => {
    it("states the deadline three different ways as the notice", () => {
      expect(notice("open")!.textContent).toBe("Kindly respond by Tuesday 1 September 2026.");
      expect(notice("closing-soon")!.textContent).toBe(
        "RSVPs close soon — kindly respond by Tuesday 1 September 2026.",
      );
      expect(notice("closed")!.textContent).toBe("RSVPs closed on Tuesday 1 September 2026.");
    });

    it("labels rather than repeats as the panel copy", () => {
      const panel = { variant: "panel" as const };
      expect(notice("open", panel)!.textContent).toBe("RSVP by Tuesday 1 September 2026");
      expect(notice("closing-soon", panel)!.textContent).toBe(
        "RSVP by Tuesday 1 September 2026 — closing soon",
      );
      expect(notice("closed", panel)!.textContent).toBe("RSVPs closed on Tuesday 1 September 2026");
    });

    it("says urgency in words, not only in colour", () => {
      // WCAG 1.4.1: a guest who can't tell the two golds apart still has to be
      // able to tell the final week from the month before it.
      expect(notice("open")!.textContent).not.toContain("soon");
      expect(notice("closing-soon")!.textContent).toContain("close soon");
      expect(notice("closing-soon", { variant: "panel" })!.textContent).toContain("closing soon");
    });
  });

  describe("the live region", () => {
    it("announces only when asked to", () => {
      expect(notice("open", { announce: true })!.getAttribute("role")).toBe("status");
      expect(notice("open")!.getAttribute("role")).toBeNull();
    });

    it("never hides the copy that does not announce", () => {
      // The second copy is silent because it is not a live region, NOT because
      // it is out of the accessibility tree — `aria-hidden` here would take the
      // date away from the screen-reader user this copy exists for.
      expect(notice("open")!.getAttribute("aria-hidden")).toBeNull();
      expect(notice("open", { variant: "panel" })!.getAttribute("aria-hidden")).toBeNull();
    });

    it("carries the shared id when given one, so aria-describedby resolves", () => {
      expect(notice("closed", { id: RSVP_NOTICE_ID })!.id).toBe(RSVP_NOTICE_ID);
      expect(notice("closed")!.id).toBe("");
    });
  });
});
