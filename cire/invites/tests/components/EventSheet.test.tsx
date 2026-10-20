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

import { cssTimeMs, EventSheet, type EventPanel } from "../../src/components/EventSheet";
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

describe("the settle's timing, read back from the computed style", () => {
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

  it("hands the details its site origin, for the calendar invite's link", () => {
    // `siteUrl` is one of the sheet's own props, split off before the rest go
    // to the form. Lost in that split, the calendar entry would say
    // "Invite: undefined".
    const { getByRole, getByText } = open("details");
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const google = getByText("Google Calendar") as HTMLAnchorElement;
    expect(new URL(google.href).searchParams.get("details")).toContain(
      "Invite: https://invite.example.com/abc",
    );
  });

  it("hands the details the household, for who is invited", () => {
    // `members` is the form's prop, passed through the split untouched; the
    // details read it too, to name who is invited when it is not everyone.
    const { getByText } = render(() => (
      <EventSheet
        event={event}
        panel="details"
        siteUrl="https://invite.example.com/abc"
        members={[priya, { ...priya, guestId: "guest-ravi", firstName: "Ravi", eventIds: [] }]}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));
    expect(getByText("Who's invited")).toBeTruthy();
    expect(getByText(/^Priya$/)).toBeTruthy();
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

    fireEvent.click(getByRole("button", { name: "Give RSVP" }));
    expect(getByRole("dialog", { name: "Respond, Mehndi" })).toBeTruthy();
  });

  it("moves to the RSVP form inside the same dialog, with focus on its heading", () => {
    const { getByRole } = open("details");
    const dialog = document.querySelector("dialog");

    fireEvent.click(getByRole("button", { name: "Give RSVP" }));

    expect(document.querySelector("dialog")).toBe(dialog);
    expect(panelOf("rsvp")!.hidden).toBe(false);
    expect(panelOf("details")!.hidden).toBe(true);
    // The heading the guest lands on says which panel this is — both panels'
    // titles are the event's name, so the name alone would sound unchanged.
    expect(document.activeElement).toBe(getByRole("heading", { name: "Respond, Mehndi" }));
  });

  it("moves back to the details, with focus on their heading", () => {
    const { getByRole } = open("rsvp");

    fireEvent.click(getByRole("button", { name: "See details" }));

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

    fireEvent.click(getByRole("button", { name: "See details" }));
    fireEvent.click(getByRole("button", { name: "Give RSVP" }));

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

    fireEvent.click(getByRole("button", { name: "Give RSVP" }));
    expect(panelOf("rsvp")!.className).toContain("animate-panel-from-end");

    // Each panel arrives from its own side — the details from the start, the
    // form from the end — and the class stays, so every later show replays it.
    fireEvent.click(getByRole("button", { name: "See details" }));
    expect(panelOf("details")!.className).toContain("animate-panel-from-start");
  });

  it("keeps the scrollport's bottom padding off for both panels, the details carrying their own", () => {
    // The form's sticky bar keeps inside its scrollport's padding, and a swipe
    // draws the form in beside the details, so the scrollport has none for
    // either panel. Where the bar sits is the browser tier's to measure.
    const { getByRole } = open("details");
    expect(scroller().className).toContain("pb-0");
    expect(scroller().className).not.toContain("pb-[max(2.5rem");
    expect(panelOf("details")!.className).toContain("pb-[max(2.5rem,env(safe-area-inset-bottom))]");

    fireEvent.click(getByRole("button", { name: "Give RSVP" }));
    expect(scroller().className).toContain("pb-0");
    expect(scroller().className).not.toContain("pb-[max(2.5rem");
  });

  it("closes the whole sheet from either panel", async () => {
    const onClose = vi.fn();
    const { getByRole } = open("details", { onClose });

    fireEvent.click(getByRole("button", { name: "Give RSVP" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape and a backdrop tap arrive as the dialog's `close` event.
    fireEvent.click(getByRole("button", { name: "See details" }));
    document.querySelector("dialog")!.dispatchEvent(new Event("close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  describe("the badge beside the close button", () => {
    it("sits in the sheet's chrome, outside both panels and the form", () => {
      // Not in the form: it is not part of the reply, and it must not send one.
      // Not in a panel: it stays put while the panel scrolls under it.
      const { getByRole } = open("rsvp");
      const badge = getByRole("button", { name: "See details" });
      expect(badge.closest("form")).toBeNull();
      expect(badge.closest("[data-panel]")).toBeNull();
      expect(badge.parentElement).toBe(getByRole("button", { name: "Close" }).parentElement);
    });

    it("clears the content of the row it sits in", () => {
      open("details");
      expect(scroller().className).toContain("pt-16");
    });

    it("stays on the form once RSVPs have closed — the details still are", () => {
      const { getByRole } = open("rsvp", { closed: true });
      expect((getByRole("button", { name: "See details" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it("is withdrawn from the form while a save is in flight and once it has saved", async () => {
      let resolve!: (r: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>((r) => (resolve = r))),
      );
      const { getByRole } = open("rsvp");
      const badge = () => getByRole("button", { name: "See details" }) as HTMLButtonElement;
      expect(badge().disabled).toBe(false);

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
      await waitFor(() => expect(badge().disabled).toBe(true));

      resolve(
        new Response(JSON.stringify({ rsvps: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await waitFor(() => expect(getByRole("button", { name: "Saved" })).toBeTruthy());
      expect(badge().disabled).toBe(true);
      vi.unstubAllGlobals();
    });

    it("keeps focus on the badge when the deadline relabels it for a household that replied", () => {
      const [closed, setClosed] = createSignal(false);
      const { getByRole } = render(() => (
        <EventSheet
          event={event}
          panel="details"
          siteUrl="https://invite.example.com/abc"
          members={[priya]}
          apiUrl="https://api.test"
          closed={closed()}
          replied
          onClose={() => {}}
        />
      ));
      const badge = getByRole("button", { name: "Give RSVP" });
      badge.focus();

      setClosed(true);

      // The same control, renamed: focus stays where the guest left it.
      expect(badge.textContent).toContain("View your RSVP");
      expect(document.activeElement).toBe(badge);
    });

    it("leaves focus where the guest put it when the deadline takes a badge they were not on", () => {
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
      const calendar = getByRole("button", { name: /add to calendar/i });
      calendar.focus();

      setClosed(true);

      expect(document.activeElement).toBe(calendar);
    });
  });

  describe("past the RSVP deadline", () => {
    it("offers no way into the RSVP form, and says the replies have closed", () => {
      const { queryByRole, getByRole } = open("details", { closed: true });

      expect(queryByRole("button", { name: "Give RSVP" })).toBeNull();
      expect(getByRole("status").textContent).toBe(
        "RSVPs closed on Sunday 1 September 2999. To reply now, please contact the couple directly.",
      );
    });

    it("takes a household that replied from the details to its reply, read-only", () => {
      const { getByRole } = render(() => (
        <EventSheet
          event={event}
          panel="details"
          siteUrl="https://invite.example.com/abc"
          members={[priya]}
          existingRsvps={[
            {
              guestId: "guest-priya",
              eventId: "event-1",
              status: "declined",
              dietary: "",
              dietaryPresets: [],
              dietaryConsentCurrent: false,
            },
          ]}
          apiUrl="https://api.test"
          closed
          replied
          closedOn="Sunday 1 September 2999"
          onClose={() => {}}
        />
      ));

      // The sheet tells the details the household has a reply on file, so the
      // notice gives the next step that fits it (F24).
      expect(getByRole("status").textContent).toBe(
        "RSVPs closed on Sunday 1 September 2999. To change your household's reply, please contact the couple directly.",
      );

      fireEvent.click(getByRole("button", { name: "View your RSVP" }));
      expect(getByRole("heading", { name: "Your RSVP, Mehndi" })).toBeTruthy();

      expect(within(fieldsetFor("Priya")).getByText("Not attending")).toBeTruthy();
      expect(document.querySelector("button[type='submit']")).toBeNull();
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
      getByRole("button", { name: "Give RSVP" }).focus();

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
      fireEvent.click(getByRole("button", { name: "See details" }));
      getByRole("button", { name: "Give RSVP" }).focus();

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
      fireEvent.click(getByRole("button", { name: "Give RSVP" }));
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
