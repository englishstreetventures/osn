/**
 * The link menu's keys, how it closes, and where it is placed.
 *
 * jsdom has no popover API, and neither do Firefox 114 and Safari 16.4, the
 * floor `.browserslistrc` names. There the menu is a fixed box placed as it
 * opens, from its estimated size since it has not yet been measured, and placed
 * again on a scroll or a resize: the placement the "is placed" cases read.
 * Where Chromium puts it, in the top layer and measured, is
 * `DetailsPanel.browser.test.tsx`'s ("the calendar menu"), and so are the keys
 * a guest presses there: opening on the arrows, moving between the items, and
 * closing on Escape and Tab. This tier keeps what only it reaches.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkMenu, type LinkMenuItem } from "../../src/components/LinkMenu";

const ITEMS: LinkMenuItem[] = [
  { label: "Google Calendar", href: "https://calendar.example/google" },
  { label: "Outlook.com", href: "https://calendar.example/outlook" },
  { label: "Apple / Outlook (.ics)", href: "blob:https://invite.example/1", download: "event.ics" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderMenu() {
  return render(() => (
    <div>
      <div data-testid="scrollport" />
      <LinkMenu label="Add to calendar" menuLabel="Add to calendar options" items={ITEMS} />
    </div>
  ));
}

const trigger = () => screen.getByRole("button", { name: "Add to calendar" });
const menu = () => screen.queryByRole("menu");
const items = () => screen.getAllByRole("menuitem");
/** Where focus is, as an item's index: -1 for anywhere else. */
const focusedItem = () => items().indexOf(document.activeElement as HTMLElement);

/**
 * A key pressed where focus is. True when the menu left the key's default
 * alone: false is a key the sheet around the menu never acts on.
 */
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

/** Opened as Enter or Space opens it: a click with no pointer, on the first item. */
async function openByKey() {
  fireEvent.click(trigger());
  await Promise.resolve();
}

describe("LinkMenu, keys in the menu", () => {
  it("reaches the last item with ArrowUp from the menu itself, where a pointer leaves focus", async () => {
    renderMenu();
    fireEvent.click(trigger(), { detail: 1 });
    await Promise.resolve();
    expect(document.activeElement).toBe(menu());

    press("ArrowUp");
    expect(focusedItem()).toBe(2);
  });

  it("leaves Enter to the item, so the link it is on opens", async () => {
    renderMenu();
    await openByKey();
    expect(press("Enter")).toBe(true);
    expect(focusedItem()).toBe(0);
  });
});

describe("LinkMenu, closing", () => {
  it("stays open for a press inside it, and closes on a second press of its trigger", () => {
    // A press is a mousedown, then a click. Closed on the mousedown, the menu
    // would be gone before the click reached an item; closed there by its own
    // trigger, the click would open it again.
    renderMenu();
    fireEvent.click(trigger(), { detail: 1 });

    fireEvent.mouseDown(items()[0]!);
    expect(menu()).not.toBeNull();

    fireEvent.mouseDown(trigger());
    fireEvent.click(trigger(), { detail: 1 });
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves Escape to the sheet once closed, and takes it again when it reopens", async () => {
    renderMenu();
    await openByKey();
    press("Escape");

    expect(press("Escape")).toBe(true);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    await Promise.resolve();
    expect(press("Escape")).toBe(false);
    expect(menu()).toBeNull();
  });

  it("leaves Escape to the page when it is unmounted open", async () => {
    // The sheet closing with the menu still open unmounts it; a key listener
    // left behind would swallow every later Escape on the page.
    const { unmount } = renderMenu();
    await openByKey();
    unmount();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });
});

describe("LinkMenu's items", () => {
  it("open a link in a new tab with no opener, and save a file where the guest is", async () => {
    renderMenu();
    await openByKey();
    const [link, , file] = items();
    expect([link!.getAttribute("target"), link!.getAttribute("rel")]).toEqual([
      "_blank",
      "noopener noreferrer",
    ]);
    expect([
      file!.getAttribute("download"),
      file!.getAttribute("target"),
      file!.getAttribute("rel"),
    ]).toEqual(["event.ics", null, null]);
  });
});

/** The trigger's box: 120 by 44, its top-left corner at (`left`, `top`). */
function box(top: number, left: number): DOMRect {
  const r = { top, left, bottom: top + 44, right: left + 120, width: 120, height: 44 };
  return { ...r, x: left, y: top, toJSON: () => r } as DOMRect;
}

/** The menu's `top` and `left`, as placed. */
function placed() {
  const el = menu()!;
  return { top: el.style.top, left: el.style.left };
}

describe("LinkMenu is placed", () => {
  // Three items: 3 × 44px, two 4px gaps, 8px padding and a 1px border each
  // side, so 158px before it is measured; 224px wide (`min-w-56`). The gutter
  // round it is 8px.
  it.each([
    ["under its trigger, at its left edge, with room both ways", 300, 40, [1024, 768], 352, 40],
    ["over its trigger when only that fits", 558, 40, [1024, 768], 392, 40],
    ["under its trigger when it fits there exactly", 550, 40, [1024, 768], 602, 40],
    ["over its trigger when it fits there exactly and not under", 174, 40, [1024, 390], 8, 40],
    [
      "under its trigger when it fits neither way, where a reader looks first",
      100,
      40,
      [1024, 300],
      152,
      40,
    ],
    [
      "inside the right-hand gutter when its trigger is near that edge",
      300,
      300,
      [390, 768],
      352,
      158,
    ],
  ] as const)("%s", (_, top, left, [width, height], menuTop, menuLeft) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
    renderMenu();
    vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue(box(top, left));
    fireEvent.click(trigger(), { detail: 1 });
    expect(placed()).toEqual({ top: `${menuTop}px`, left: `${menuLeft}px` });
  });

  it("again when a scrollport inside the page scrolls, and when the window resizes", async () => {
    // A scroll does not bubble: only a listener on the capture path hears the
    // sheet's own scrollport move the trigger under the menu.
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    renderMenu();
    const rect = vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue(box(300, 40));
    fireEvent.click(trigger(), { detail: 1 });
    expect(placed().top).toBe("352px");

    rect.mockReturnValue(box(200, 40));
    screen.getByTestId("scrollport").dispatchEvent(new Event("scroll"));
    await frame();
    expect(placed().top).toBe("252px");

    rect.mockReturnValue(box(100, 40));
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(placed().top).toBe("152px");
  });
});
