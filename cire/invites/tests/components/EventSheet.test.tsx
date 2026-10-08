/**
 * The event sheet's wiring: which panel it opens on, what a switch mounts,
 * hides, names and focuses, and what the RSVP deadline does to the way between
 * the two panels.
 *
 * jsdom implements no `<dialog>` and computes no CSS, so nothing here can say
 * whether a hidden panel is really off screen, whether the slide plays, or
 * where the platform puts focus on close. `EventSheet.browser.test.tsx` holds
 * those. What this tier can hold is the state behind them.
 */
import { render, cleanup, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  cssTimeMs,
  EventSheet,
  firstOfCssList,
  type EventPanel,
} from "../../src/components/EventSheet";
import type { EventSummary, FamilyMember } from "../../src/components/types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

vi.mock("@shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "Henna evening",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};

function open(panel: EventPanel, extra: { closed?: boolean; onClose?: () => void } = {}) {
  return render(() => (
    <EventSheet
      event={event}
      panel={panel}
      siteUrl="https://invite.example.com/abc"
      members={[priya]}
      apiUrl="https://api.test"
      closed={extra.closed}
      closedOn="Sunday 1 September 2999"
      onClose={extra.onClose ?? (() => {})}
    />
  ));
}

/** The wrapper `EventSheet` puts around one panel. */
function panelOf(name: EventPanel): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
}

/** The scroll container `AnimatedModal` lays the panels out in. */
function scroller(): HTMLElement {
  return document.querySelector("dialog")!.lastElementChild as HTMLElement;
}

function fieldsetFor(name: string): HTMLElement {
  for (const l of document.querySelectorAll("legend")) {
    if ((l.textContent ?? "").includes(name)) return l.closest("fieldset") as HTMLElement;
  }
  throw new Error(`fieldset for ${name} not found`);
}

describe("the slide's timing, read back from the computed style", () => {
  it("keeps a cubic-bezier whole — its own commas are not list separators", () => {
    // The sheet's resize takes its curve from here. Split naively, this
    // handed `animate()` "cubic-bezier(0.22", which it refuses with a throw.
    expect(firstOfCssList("cubic-bezier(0.22, 1, 0.36, 1)")).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(firstOfCssList("cubic-bezier(0.22, 1, 0.36, 1), ease")).toBe(
      "cubic-bezier(0.22, 1, 0.36, 1)",
    );
    expect(firstOfCssList("ease-out, linear")).toBe("ease-out");
  });

  it("reads a duration in seconds or milliseconds, and the clamped one too", () => {
    expect(cssTimeMs("0.28s")).toBe(280);
    expect(cssTimeMs("280ms")).toBe(280);
    expect(cssTimeMs("0.28s, 1s")).toBe(280);
    // The reduced-motion clamp, as Chromium serialises 0.01ms.
    expect(cssTimeMs("1e-05s")).toBeCloseTo(0.01);
    // jsdom computes no animation at all.
    expect(cssTimeMs("")).toBe(0);
  });
});

describe("EventSheet", () => {
  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
  });

  it("opens on the details when asked, and mounts nothing of the RSVP form", () => {
    const { getByRole, queryByRole } = open("details");

    expect(getByRole("heading", { name: "Details, Mehndi" })).toBeTruthy();
    expect(queryByRole("button", { name: "Save" })).toBeNull();
    expect(panelOf("rsvp")).toBeNull();
  });

  it("opens on the RSVP form when asked, and mounts nothing of the details", () => {
    // The details carry the consent-gated map and moodboard. A guest who only
    // answers never mounts them, as before the two sheets became one.
    const { getByRole, queryByRole } = open("rsvp");

    expect(getByRole("heading", { name: "Respond, Mehndi" })).toBeTruthy();
    expect(queryByRole("button", { name: /add to calendar/i })).toBeNull();
    expect(panelOf("details")).toBeNull();
  });

  it("names the dialog after the panel on screen", () => {
    const { getByRole } = open("details");
    expect(getByRole("dialog", { name: "Details, Mehndi" })).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));
    expect(getByRole("dialog", { name: "Respond, Mehndi" })).toBeTruthy();
  });

  it("moves to the RSVP form inside the same dialog, with focus on its heading", () => {
    const { getByRole } = open("details");
    const dialog = document.querySelector("dialog");

    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));

    expect(document.querySelector("dialog")).toBe(dialog);
    expect(panelOf("rsvp")!.hidden).toBe(false);
    expect(panelOf("details")!.hidden).toBe(true);
    // The heading the guest lands on says which panel this is — both panels'
    // titles are the event's name, so the name alone would sound unchanged.
    expect(document.activeElement).toBe(getByRole("heading", { name: "Respond, Mehndi" }));
  });

  it("moves back to the details, with focus on their heading", () => {
    const { getByRole } = open("rsvp");

    fireEvent.click(getByRole("button", { name: "View event details" }));

    expect(panelOf("details")!.hidden).toBe(false);
    expect(panelOf("rsvp")!.hidden).toBe(true);
    expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
  });

  it("keeps the reply given so far across a visit to the details", () => {
    const { getByRole } = open("rsvp");
    const form = document.querySelector("form");
    const attending = within(fieldsetFor("Priya")).getByText("Attending");
    fireEvent.click(attending);
    expect(attending.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByRole("button", { name: "View event details" }));
    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));

    // The same form, not a fresh one built from the stored rows: a remount
    // would have thrown the unsaved answer away.
    expect(document.querySelector("form")).toBe(form);
    expect(within(fieldsetFor("Priya")).getByText("Attending").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("slides in only a panel the guest switched to, not the one the sheet opened on", () => {
    // The panel the sheet opens on rides the sheet's own entry; animating it as
    // well would play two entries on top of each other.
    const { getByRole } = open("details");
    expect(panelOf("details")!.className).not.toContain("animate-panel-from");

    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));
    expect(panelOf("rsvp")!.className).toContain("animate-panel-from-end");

    // Each panel arrives from its own side — the details from the start, the
    // form from the end — and the class stays, so every later show replays it.
    fireEvent.click(getByRole("button", { name: "View event details" }));
    expect(panelOf("details")!.className).toContain("animate-panel-from-start");
  });

  it("drops the sheet's bottom padding only while the RSVP form, with its sticky bar, shows", () => {
    const { getByRole } = open("details");
    expect(scroller().className).toContain("pb-[max(2.5rem,env(safe-area-inset-bottom))]");

    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));
    expect(scroller().className).toContain("pb-0");
    expect(scroller().className).not.toContain("pb-[max(2.5rem");
  });

  it("closes the whole sheet from either panel", async () => {
    const onClose = vi.fn();
    const { getByRole } = open("details", { onClose });

    fireEvent.click(getByRole("button", { name: "RSVP for this event" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape and a backdrop tap arrive as the dialog's `close` event.
    fireEvent.click(getByRole("button", { name: "View event details" }));
    document.querySelector("dialog")!.dispatchEvent(new Event("close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  describe("past the RSVP deadline", () => {
    it("offers no way into the RSVP form, and says the replies have closed", () => {
      const { queryByRole, getByRole } = open("details", { closed: true });

      expect(queryByRole("button", { name: "RSVP for this event" })).toBeNull();
      expect(getByRole("status").textContent).toBe("RSVPs closed on Sunday 1 September 2999.");
    });

    it("says nothing in that line while the replies are open", () => {
      // The live region exists from the start, empty, so a deadline that passes
      // later is a change inside a region already being watched.
      const { getByRole } = open("details");
      expect(getByRole("status").textContent).toBe("");
    });

    it("keeps focus inside the dialog when the deadline takes the RSVP button from under it", () => {
      const [closed, setClosed] = createSignal(false);
      const { getByRole } = render(() => (
        <EventSheet
          event={event}
          panel="details"
          siteUrl="https://invite.example.com/abc"
          members={[priya]}
          apiUrl="https://api.test"
          closed={closed()}
          onClose={() => {}}
        />
      ));
      getByRole("button", { name: "RSVP for this event" }).focus();

      setClosed(true);

      expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
    });

    it("lands that focus on the details, not on the RSVP form hidden behind them", () => {
      // The form stays mounted once visited, and it has a focus rescue of its
      // own for the same deadline. Only the panel on screen may act on it.
      const [closed, setClosed] = createSignal(false);
      const { getByRole } = render(() => (
        <EventSheet
          event={event}
          panel="rsvp"
          siteUrl="https://invite.example.com/abc"
          members={[priya]}
          apiUrl="https://api.test"
          closed={closed()}
          onClose={() => {}}
        />
      ));
      fireEvent.click(getByRole("button", { name: "View event details" }));
      getByRole("button", { name: "RSVP for this event" }).focus();

      setClosed(true);

      expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
    });

    it("lands focus in the form, not on the details hidden behind it, when Save goes", async () => {
      // The other way round. The details mounted first, so their rescue runs
      // first; told they are hidden, they leave focus for the form's own
      // rescue to put on its Close button.
      const [closed, setClosed] = createSignal(false);
      const { getByRole } = render(() => (
        <EventSheet
          event={event}
          panel="details"
          siteUrl="https://invite.example.com/abc"
          members={[priya]}
          apiUrl="https://api.test"
          closed={closed()}
          onClose={() => {}}
        />
      ));
      fireEvent.click(getByRole("button", { name: "RSVP for this event" }));
      (document.querySelector("button[type='submit']") as HTMLButtonElement).focus();

      setClosed(true);

      await waitFor(() => expect(document.querySelector("button[type='submit']")).toBeNull());
      const focused = document.activeElement as HTMLElement;
      expect(focused.textContent).toBe("Close");
      expect(focused.closest("[data-panel]")?.getAttribute("data-panel")).toBe("rsvp");
    });
  });

  it("paints the sheet in the theme it is given, through the allow-list", () => {
    // The page hands the sheet the events section's tones; the sheet hands
    // them to the dialog, which paints outside the themed section.
    render(() => (
      <EventSheet
        event={event}
        panel="details"
        siteUrl="https://invite.example.com/abc"
        members={[priya]}
        apiUrl="https://api.test"
        themeVars={{
          "--invite-section-bg": "var(--color-surface-raised)",
          "background-image": "url(https://evil.example/x)",
        }}
        onClose={() => {}}
      />
    ));

    const dialog = document.querySelector("dialog")!;
    expect(dialog.style.getPropertyValue("--invite-section-bg")).toBe(
      "var(--color-surface-raised)",
    );
    expect(dialog.style.getPropertyValue("background-image")).toBe("");
  });
});
