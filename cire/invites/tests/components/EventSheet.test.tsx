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

/**
 * A segment of the switch in the sheet's chrome, by its words. Scoped to the
 * dialog: the page around a sheet has its own "Respond" on the event card.
 */
function segment(name: string): HTMLButtonElement {
  return within(document.querySelector("dialog")!).getByRole("button", {
    name,
  }) as HTMLButtonElement;
}

/** The switch itself, or null when the sheet shows none. */
function panelSwitch(): HTMLElement | null {
  return within(document.querySelector("dialog")!).queryByRole("group", { name: "Event sheet" });
}

/** The scroll container `AnimatedModal` lays the panels out in. */
function scroller(): HTMLElement {
  return document.querySelector("dialog")!.lastElementChild as HTMLElement;
}

/** The headings inside `root` whose words include `text`. */
function headingsNaming(text: string, root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].filter((h) =>
    (h.textContent ?? "").includes(text),
  );
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
    document.documentElement.style.overflow = "";
    document.documentElement.style.scrollbarGutter = "";
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

  it("titles the sheet in its bar, with one title per panel", () => {
    // One title per panel, so every switch moves focus to a different
    // element: focus sent to the element already holding it is no move at
    // all, and nothing would be announced.
    const { getByRole } = open("details");
    const bar = scroller().firstElementChild as HTMLElement;
    const details = getByRole("heading", { name: "Details, Mehndi" });
    expect(details.tagName).toBe("H2");
    expect(bar.contains(details)).toBe(true);
    // Focusable by script only: it is where a switch sends focus, and a
    // title has no place in the Tab order.
    expect(details.getAttribute("tabindex")).toBe("-1");
    expect(document.querySelector("dialog")!.getAttribute("aria-labelledby")).toBe(details.id);
    // The panels carry no title of their own: the bar's is the only one.
    expect(headingsNaming("Mehndi", panelOf("details")!)).toEqual([]);

    fireEvent.click(segment("Respond"));
    const respond = getByRole("heading", { name: "Respond, Mehndi" });
    expect(respond).not.toBe(details);
    expect(respond.tagName).toBe("H2");
    expect(bar.contains(respond)).toBe(true);
    expect(details.hidden).toBe(true);
    expect(document.querySelector("dialog")!.getAttribute("aria-labelledby")).toBe(respond.id);
    expect(headingsNaming("Mehndi", panelOf("rsvp")!)).toEqual([]);
  });

  it("names the dialog after the panel on screen", () => {
    const { getByRole } = open("details");
    expect(getByRole("dialog", { name: "Details, Mehndi" })).toBeTruthy();

    fireEvent.click(segment("Respond"));
    expect(getByRole("dialog", { name: "Respond, Mehndi" })).toBeTruthy();
  });

  it("moves to the RSVP form inside the same dialog, with focus on its heading", () => {
    const { getByRole } = open("details");
    const dialog = document.querySelector("dialog");

    fireEvent.click(segment("Respond"));

    expect(document.querySelector("dialog")).toBe(dialog);
    expect(panelOf("rsvp")!.hidden).toBe(false);
    expect(panelOf("details")!.hidden).toBe(true);
    // The heading the guest lands on says which panel this is — both panels'
    // titles are the event's name, so the name alone would sound unchanged.
    expect(document.activeElement).toBe(getByRole("heading", { name: "Respond, Mehndi" }));
  });

  it("moves back to the details, with focus on their heading", () => {
    const { getByRole } = open("rsvp");

    fireEvent.click(segment("Details"));

    expect(panelOf("details")!.hidden).toBe(false);
    expect(panelOf("rsvp")!.hidden).toBe(true);
    expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
  });

  it("keeps the reply given so far across a visit to the details", () => {
    open("rsvp");
    const form = document.querySelector("form");
    const attending = within(fieldsetFor("Priya")).getByText("Attending");
    fireEvent.click(attending);
    expect(attending.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(segment("Details"));
    fireEvent.click(segment("Respond"));

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
    open("details");
    expect(panelOf("details")!.className).not.toContain("animate-panel-from");

    fireEvent.click(segment("Respond"));
    expect(panelOf("rsvp")!.className).toContain("animate-panel-from-end");

    // Each panel arrives from its own side — the details from the start, the
    // form from the end — and the class stays, so every later show replays it.
    fireEvent.click(segment("Details"));
    expect(panelOf("details")!.className).toContain("animate-panel-from-start");
  });

  it("closes the whole sheet from either panel", async () => {
    const onClose = vi.fn();
    const { getByRole } = open("details", { onClose });

    fireEvent.click(segment("Respond"));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape and a backdrop tap arrive as the dialog's `close` event.
    fireEvent.click(segment("Details"));
    document.querySelector("dialog")!.dispatchEvent(new Event("close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  describe("the switch beside the close button", () => {
    it("sits in the sheet's chrome, outside both panels and the form", () => {
      // Not in the form: it is not part of the reply, and it must not send one.
      // Not in a panel: it stays put while the panel scrolls under it.
      const { getByRole } = open("rsvp");
      const group = segment("Details").closest('[role="group"]') as HTMLElement;
      expect(group).toBe(panelSwitch());
      expect(group.closest("form")).toBeNull();
      expect(group.closest("[data-panel]")).toBeNull();
      expect(group.parentElement).toBe(getByRole("button", { name: "Close" }).parentElement);
    });

    it("shows both panels, and marks the one on screen", () => {
      // Both segments, always: the row never stands empty, and the guest can
      // see where else there is to go.
      open("details");
      expect(segment("Details").getAttribute("aria-pressed")).toBe("true");
      expect(segment("Respond").getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(segment("Respond"));
      expect(segment("Details").getAttribute("aria-pressed")).toBe("false");
      expect(segment("Respond").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing when the segment on screen is pressed", () => {
      const { getByRole } = open("details");
      const heading = getByRole("heading", { name: "Details, Mehndi" });
      fireEvent.click(segment("Details"));
      expect(panelOf("rsvp")).toBeNull();
      expect(panelOf("details")!.hidden).toBe(false);
      expect(document.activeElement).not.toBe(heading);
    });

    // jsdom plays no slide, so the panel's arrival lasts until the next
    // microtask: a second press dispatched straight after the first lands
    // inside it, as a double tap's second tap lands inside a real slide.
    it.each([
      ["ignores a tap", 1, "rsvp"],
      ["takes a key press", 0, "details"],
    ] as const)(
      "%s on the other segment while the panel just chosen arrives",
      (_, detail, onScreen) => {
        open("details");
        fireEvent.click(segment("Respond"), { detail });
        fireEvent.click(segment("Details"), { detail });
        expect({ details: !panelOf("details")!.hidden, rsvp: !panelOf("rsvp")!.hidden }).toEqual({
          details: onScreen === "details",
          rsvp: onScreen === "rsvp",
        });
      },
    );

    it("sits in a bar ahead of both panels in the scroller, so they scroll under it", () => {
      open("details");
      const bar = scroller().firstElementChild as HTMLElement;
      expect(bar.contains(panelSwitch())).toBe(true);
      expect(
        bar.contains(
          within(document.querySelector("dialog")!).getByRole("button", { name: "Close" }),
        ),
      ).toBe(true);
      // The panels follow the bar, in their own wrapper: the bar is no part of
      // either, so a swipe never moves it and never starts on it.
      expect(bar.contains(panelOf("details"))).toBe(false);
      expect(bar.compareDocumentPosition(panelOf("details")!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it("keeps Details pressable on the form once RSVPs have closed — the details still are", () => {
      const { getByRole, queryByRole } = open("rsvp", { closed: true });
      expect(segment("Details").disabled).toBe(false);
      expect(segment("Your RSVP").getAttribute("aria-pressed")).toBe("true");
      // Nothing is left to respond to, so the title names what the form shows.
      expect(getByRole("heading", { name: "Your RSVP, Mehndi" })).toBeTruthy();
      expect(queryByRole("heading", { name: "Respond, Mehndi" })).toBeNull();
    });

    it("disables Details on the form while a save is in flight and once it has saved", async () => {
      let resolve!: (r: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>((r) => (resolve = r))),
      );
      const { getByRole } = open("rsvp");
      const details = () => segment("Details");
      expect(details().disabled).toBe(false);

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
      await waitFor(() => expect(details().disabled).toBe(true));

      resolve(
        new Response(JSON.stringify({ rsvps: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await waitFor(() => expect(getByRole("button", { name: "Saved" })).toBeTruthy());
      expect(details().disabled).toBe(true);
      vi.unstubAllGlobals();
    });

    it("keeps focus on the form's segment when the deadline relabels it for a household that replied", () => {
      const [closed, setClosed] = createSignal(false);
      render(() => (
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
      const respond = segment("Respond");
      respond.focus();

      setClosed(true);

      // The same control, renamed: focus stays where the guest left it.
      expect(respond.textContent).toBe("Your RSVP");
      expect(document.activeElement).toBe(respond);
    });

    it("leaves focus where the guest put it when the deadline takes a switch they were not on", () => {
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
      const { getByRole } = open("details", { closed: true });

      expect(panelSwitch()).toBeNull();
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

      fireEvent.click(segment("Your RSVP"));
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
      segment("Respond").focus();

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
      fireEvent.click(segment("Details"));
      segment("Respond").focus();

      setClosed(true);

      expect(document.activeElement).toBe(getByRole("heading", { name: "Details, Mehndi" }));
    });

    it("lands focus in the form, not on the details hidden behind it, when Save goes", async () => {
      // The other way round. The details mounted first, so their rescue runs
      // first; told they are hidden, they leave focus for the form's own
      // rescue to put on its Close button.
      const [closed, setClosed] = createSignal(false);
      render(() => (
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
      fireEvent.click(segment("Respond"));
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
