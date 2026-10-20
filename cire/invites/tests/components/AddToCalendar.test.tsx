import { render, fireEvent, cleanup, screen } from "@solidjs/testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AddToCalendar } from "../../src/components/AddToCalendar";
import type { EventSummary } from "../../src/components/types";

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Reception, Cocktail Hour & Dinner",
  description: "An evening of feasting",
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

const SITE_URL = "https://invite.example.com/abc-123";

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let urlCounter = 0;
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  urlCounter = 0;
  createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
  revokeObjectURL = vi.fn();
  // Patch the methods on the real URL constructor so `new URL(...)` keeps
  // working (jsdom doesn't ship createObjectURL by default).
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  if (originalCreate === undefined) {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  } else {
    URL.createObjectURL = originalCreate;
  }
  if (originalRevoke === undefined) {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  } else {
    URL.revokeObjectURL = originalRevoke;
  }
});

describe("AddToCalendar", () => {
  it("toggles aria-expanded when the button is clicked", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = getByRole("button", { name: /add to calendar/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a Google Calendar link with the correct href when open", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const link = screen.getByText("Google Calendar") as HTMLAnchorElement;
    expect(link.href).toContain("https://calendar.google.com/calendar/render");
    expect(link.href).toContain("text=Reception%2C+Cocktail+Hour+%26+Dinner");
    expect(link.href).toContain("ctz=Australia%2FSydney");
    expect(link.href).toContain("dates=20260918T060000Z%2F20260918T120000Z");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("renders an .ics download link with a sanitised filename", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const link = screen.getByText("Apple / Outlook (.ics)") as HTMLAnchorElement;
    // Download attribute must be sanitised to printable ASCII (no spaces, no
    // commas, no &). "Reception, Cocktail Hour & Dinner" -> underscores.
    expect(link.getAttribute("download")).toBe("Reception__Cocktail_Hour___Dinner.ics");
    expect(link.getAttribute("href")).toMatch(/^blob:mock-/);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("renders the menu in place, so a modal sheet cannot make it inert", () => {
    // The details sheet is a `showModal()` dialog, and a modal dialog makes
    // every node outside it inert — not hit-testable, not reachable by
    // assistive technology, however it is painted. A menu portalled to
    // `document.body` is therefore visible and dead, which is the same bug
    // report as #203 from the guest's side. Rendering in place is what keeps it
    // live; being a `popover` is what gets it out of every ancestor stacking
    // context, which is the whole job a portal would be doing.
    const { getByRole, container } = render(() => (
      <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
    ));
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(true);
  });

  it("keeps its z-index for the case the top layer does not cover", () => {
    // Opened from an event card rather than from the sheet, the menu is an
    // ordinary fixed box competing with the page: at z-90 it rendered behind
    // the cards it was opened over. That the top layer settles the other case
    // is asserted in `lib/z-index.browser.test.tsx`, which needs an engine.
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("z-110");
    expect(menu.className).not.toContain("z-90");
  });

  it("closes when Escape is pressed", () => {
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the user clicks outside the popover", () => {
    const { getByRole } = render(() => (
      <div>
        <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
        <span data-testid="outside">outside</span>
      </div>
    ));
    const button = getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseDown(document.body);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not allocate an object URL until the popover opens", () => {
    const { unmount } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    expect(createObjectURL).toHaveBeenCalledTimes(0);
    unmount();
  });

  it("revokes the object URL on unmount once the popover has been opened", () => {
    const { getByRole, unmount } = render(() => (
      <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />
    ));
    fireEvent.click(getByRole("button", { name: /add to calendar/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const created = createObjectURL.mock.results[0].value as string;
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(created);
  });

  it("draws a text action, never a filled one, 44px tall", () => {
    // It sits in the "When" row of the key facts, under the date: a quiet
    // action beside the fact it acts on, not a second call to action.
    const { getByRole } = render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = getByRole("button", { name: "Add to calendar" });
    expect(button.className).not.toContain("bg-gold");
    expect(button.className.split(/\s+/)).toContain("min-h-11");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
  });
});

describe("AddToCalendar — the menu from the keyboard", () => {
  const items = () => screen.getAllByRole("menuitem");
  const open = () => {
    const button = screen.getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    return button;
  };
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document).dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

  it("keeps its items out of the tab order, as a menu's are", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    open();
    await settle();
    expect(items().map((i) => i.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("moves with the arrow keys, wrapping at both ends", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    open();
    await settle();
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("jumps with Home and End", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    open();
    await settle();
    press("End");
    expect(document.activeElement).toBe(items()[1]);
    press("Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("claims the keys it moves with, so the sheet behind does not scroll", async () => {
    // Where the popover API is missing the menu is a fixed box inside the
    // sheet's scrollport, and an unclaimed arrow scrolls the sheet under it.
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    open();
    await settle();
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect({ key, prevented: press(key).defaultPrevented }).toEqual({ key, prevented: true });
    }
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = open();
    await settle();
    const event = press("Escape");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    // Claimed, so the modal sheet it sits in does not close as well.
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on Tab from the trigger and leaves the move to the browser", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = open();
    await settle();
    for (const shiftKey of [false, true]) {
      if (button.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(button);
        await settle();
      }
      const event = press("Tab", { shiftKey });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("opens from the trigger with ArrowDown on the first item, ArrowUp on the last", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = screen.getByRole("button", { name: /add to calendar/i });
    button.focus();
    const down = press("ArrowDown");
    await settle();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items()[0]);
    expect(down.defaultPrevented).toBe(true);

    press("Escape");
    press("ArrowUp");
    await settle();
    expect(document.activeElement).toBe(items()[1]);
  });

  it("makes each item a 44px target", async () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    open();
    await settle();
    for (const item of items()) expect(item.className.split(/\s+/)).toContain("min-h-11");
  });
});

describe("AddToCalendar — where the menu opens", () => {
  // jsdom lays nothing out, so the trigger's box and the viewport are set by
  // hand; the menu has no height of its own here, so its estimate (110px:
  // two 44px items and the padding) is what is measured against.
  const originalHeight = window.innerHeight;
  afterEach(() => {
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
  });

  function openWith(rect: { top: number; bottom: number }, viewportHeight: number) {
    Object.defineProperty(window, "innerHeight", { value: viewportHeight, configurable: true });
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = screen.getByRole("button", { name: /add to calendar/i });
    button.getBoundingClientRect = () =>
      ({ top: rect.top, bottom: rect.bottom, left: 16, right: 140 }) as DOMRect;
    fireEvent.click(button);
    return screen.getByRole("menu").style.top;
  }

  it("opens below the trigger when it fits there", () => {
    expect(openWith({ top: 60, bottom: 100 }, 800)).toBe("108px");
  });

  it("opens below when it fits with exactly the margin to spare", () => {
    // 178 + 110 = 288 = 296 - 8: fits, so below, though above would fit too.
    expect(openWith({ top: 130, bottom: 170 }, 296)).toBe("178px");
  });

  it("opens above when below would end inside the margin at the screen's foot", () => {
    // 178 + 110 = 288, past 290 - 8: below would touch the edge, so above.
    expect(openWith({ top: 130, bottom: 170 }, 290)).toBe("12px");
  });

  it("opens above the trigger when it does not fit below", () => {
    // Below would end at 858 on an 800px screen; above it ends 8px over the trigger.
    expect(openWith({ top: 700, bottom: 740 }, 800)).toBe("582px");
  });

  it("opens above when that leaves exactly the margin at the top", () => {
    expect(openWith({ top: 126, bottom: 166 }, 200)).toBe("8px");
  });

  it("opens below when it fits on neither side", () => {
    expect(openWith({ top: 50, bottom: 90 }, 150)).toBe("98px");
  });
});

describe("AddToCalendar — keys on the trigger itself", () => {
  const settle = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  const press = (target: Element, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  async function openThenBackToTrigger() {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = screen.getByRole("button", { name: /add to calendar/i });
    fireEvent.click(button);
    await settle();
    button.focus();
    return button;
  }

  it("sends ArrowUp on the trigger of an open menu to the last item", async () => {
    const button = await openThenBackToTrigger();
    press(button, "ArrowUp");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
  });

  it("closes an open menu on Escape or Tab with focus on the trigger", async () => {
    for (const key of ["Escape", "Tab"]) {
      const button = await openThenBackToTrigger();
      press(button, key);
      expect({ key, expanded: button.getAttribute("aria-expanded") }).toEqual({
        key,
        expanded: "false",
      });
      cleanup();
    }
  });

  it("leaves every other key on a closed trigger to the browser", () => {
    render(() => <AddToCalendar event={baseEvent} siteUrl={SITE_URL} />);
    const button = screen.getByRole("button", { name: /add to calendar/i });
    for (const key of ["a", "ArrowLeft", "PageDown"]) {
      const event = press(button, key);
      expect({ key, prevented: event.defaultPrevented }).toEqual({ key, prevented: false });
    }
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
