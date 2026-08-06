// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Module } from "../lib/dashboard-route";
import CommandPalette from "./CommandPalette";
import type { WeddingSummary } from "./CreateWeddingForm";

/**
 * ⌘K is the keyboard route to anywhere in the portal, and the reason the chrome
 * can stay one row tall: an affordance that would otherwise need a permanent
 * button lives here instead. So what these tests pin is reach and correctness of
 * the wiring — every destination present, the right one run — plus the two
 * things a combobox-over-listbox gets wrong when nobody is watching: that focus
 * stays in the field while `aria-activedescendant` moves the highlight, and that
 * the highlight can never point past the end of a filtered list.
 *
 * happy-dom has no layout, so `scrollIntoView` is stubbed rather than asserted.
 */

const wedding = (id: string, displayName: string, slug: string): WeddingSummary => ({
  id,
  slug,
  displayName,
  role: "owner",
  entitlements: [],
  guestCap: 100,
});

const RUTH = wedding("wed_1", "Ruth & Vik", "ruth-and-vik");
const MAYA = wedding("wed_2", "Maya & Sol", "maya-and-sol");

function mount(opts: { open?: boolean; wedding?: WeddingSummary | null } = {}) {
  const [open, setOpen] = createSignal(opts.open ?? true);
  const spies = {
    onModule: vi.fn<(module: Module) => void>(),
    onWedding: vi.fn<(w: WeddingSummary) => void>(),
    onAll: vi.fn(),
    onSecurity: vi.fn(),
    onSignOut: vi.fn(),
  };
  const onOpenChange = vi.fn((next: boolean) => setOpen(next));
  const utils = render(() => (
    <CommandPalette
      open={open()}
      onOpenChange={onOpenChange}
      wedding={opts.wedding === undefined ? RUTH : opts.wedding}
      weddings={[RUTH, MAYA]}
      {...spies}
    />
  ));
  return { ...utils, ...spies, onOpenChange, open, setOpen };
}

const input = () => screen.getByRole("combobox", { name: /search commands/i }) as HTMLInputElement;
const options = () => screen.getAllByRole("option");
/** The row the combobox currently points at, read the way a screen reader does. */
const activeRow = () => document.getElementById(input().getAttribute("aria-activedescendant")!);
const type = (value: string) => fireEvent.input(input(), { target: { value } });

beforeEach(() => {
  // No layout in happy-dom, and Element.scrollIntoView is not implemented.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CommandPalette", () => {
  it("renders nothing until it is opened", () => {
    mount({ open: false });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers every module of the open wedding, grouped under Go to", () => {
    mount();
    expect(screen.getByText("Go to")).toBeTruthy();
    for (const label of ["Overview", "Schedule", "Guests", "Invite", "Settings"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("drops the module group when no wedding is open", () => {
    // On the wedding list there is nothing to go *into* — the group would be a
    // set of rows that navigate nowhere.
    mount({ wedding: null });
    expect(screen.queryByText("Go to")).toBeNull();
    expect(screen.queryByText("Overview")).toBeNull();
    expect(screen.getByText("All weddings")).toBeTruthy();
  });

  it("lists the other weddings but not the one already open", () => {
    mount();
    expect(screen.getByText("Maya & Sol")).toBeTruthy();
    expect(screen.queryByText("Ruth & Vik")).toBeNull();
  });

  it("matches on the hint and keywords, not just the label", () => {
    // A host looking for RSVPs types "rsvp"; the row is called Guests.
    mount();
    type("rsvp");
    const labels = options().map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Guests"))).toBe(true);
    expect(labels.some((l) => l?.includes("Sign out"))).toBe(false);
  });

  it("says so plainly when nothing matches", () => {
    mount();
    type("zzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
    // With no row to point at, the combobox must not name a dead descendant.
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("keeps focus in the field and moves the highlight with the arrows", () => {
    mount();
    input().focus();
    expect(activeRow()?.textContent).toContain("Overview");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(input());
    expect(activeRow()?.textContent).toContain("Schedule");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(activeRow()?.textContent).toContain("Overview");
  });

  it("wraps the highlight at both ends", () => {
    mount();
    const last = () => options().at(-1);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(activeRow()).toBe(last());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(activeRow()).toBe(options()[0]);
  });

  it("jumps to the ends with Home and End", () => {
    mount();
    fireEvent.keyDown(input(), { key: "End" });
    expect(activeRow()).toBe(options().at(-1));
    fireEvent.keyDown(input(), { key: "Home" });
    expect(activeRow()).toBe(options()[0]);
  });

  it("pulls the highlight back in range as the result set shrinks", () => {
    // Arrow to the bottom of the full list, then filter down to fewer rows than
    // that index. Without the clamp the combobox points at a row that is gone.
    mount();
    fireEvent.keyDown(input(), { key: "End" });
    type("sign out");
    expect(options()).toHaveLength(1);
    expect(activeRow()).toBe(options()[0]);
  });

  it("runs the highlighted command on Enter, and closes first", () => {
    const { onModule, onOpenChange } = mount();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onModule).toHaveBeenCalledWith("schedule");
    // Closed before the command navigates — a dialog still trapping focus while
    // the view behind it swaps is how focus ends up on <body>.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs a command on click", () => {
    const { onSignOut } = mount();
    type("sign out");
    fireEvent.click(options()[0]!);
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("switching wedding reports the whole wedding, not its id", () => {
    const { onWedding } = mount();
    type("maya");
    fireEvent.click(options()[0]!);
    expect(onWedding).toHaveBeenCalledWith(MAYA);
  });

  it("routes the account rows", () => {
    const { onSecurity } = mount();
    type("passkey");
    fireEvent.click(options()[0]!);
    expect(onSecurity).toHaveBeenCalledOnce();
  });

  it("moves the highlight to whatever the pointer is over", () => {
    mount();
    const schedule = options()[1]!;
    fireEvent.pointerMove(schedule);
    expect(activeRow()).toBe(schedule);
  });

  it("opens on ⌘K and closes on a second press, from anywhere on the page", async () => {
    const { onOpenChange } = mount({ open: false });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("takes Ctrl+K and a capitalised K too", () => {
    const { onOpenChange } = mount({ open: false });
    fireEvent.keyDown(document, { key: "K", ctrlKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("ignores a bare k", () => {
    const { onOpenChange } = mount({ open: false });
    fireEvent.keyDown(document, { key: "k" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reopens empty and at the top", async () => {
    // A palette that reopens holding the last search is one you have to clear
    // before you can use it.
    const { setOpen } = mount();
    type("sign out");
    fireEvent.keyDown(input(), { key: "End" });
    setOpen(false);
    setOpen(true);
    await waitFor(() => expect(input().value).toBe(""));
    expect(activeRow()).toBe(options()[0]);
  });
});
