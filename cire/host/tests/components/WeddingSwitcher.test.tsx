// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WeddingSummary } from "../../src/components/CreateWeddingForm";
import WeddingSwitcher from "../../src/components/WeddingSwitcher";

/**
 * WeddingSwitcher is the top bar's answer to "which wedding am I in, and how do
 * I leave". The trigger doubles as the label, so what the host reads to know
 * where they are is the same control they press to go elsewhere.
 *
 * Kobalte's menu trigger opens on pointerdown and its items select on pointerup
 * — the helpers below mirror that, as ProfileMenu's tests do.
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
const NELL = wedding("wed_3", "Nell & Jo", "nell-and-jo");

function mount(opts: {
  current?: WeddingSummary;
  weddings?: WeddingSummary[];
  onSelect?: (w: WeddingSummary) => void;
  onAll?: () => void;
}) {
  const onSelect = vi.fn(opts.onSelect ?? (() => {}));
  const onAll = vi.fn(opts.onAll ?? (() => {}));
  const utils = render(() => (
    <WeddingSwitcher
      current={opts.current ?? RUTH}
      weddings={opts.weddings ?? [RUTH, MAYA, NELL]}
      onSelect={onSelect}
      onAll={onAll}
    />
  ));
  return { ...utils, onSelect, onAll };
}

const trigger = () => screen.getByRole("button", { name: /switch wedding/i });
const open = () => fireEvent.pointerDown(trigger(), { button: 0 });

describe("WeddingSwitcher", () => {
  afterEach(cleanup);

  it("names the open wedding on the trigger", () => {
    mount({});
    expect(trigger().textContent).toContain("Ruth & Vik");
  });

  it("lists every other wedding, and never the current one", async () => {
    mount({});
    open();
    expect(await screen.findByText("Maya & Sol")).toBeTruthy();
    expect(screen.getByText("Nell & Jo")).toBeTruthy();
    // Offering the wedding you are already in is a row that does nothing.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent).some((t) => t?.includes("Ruth & Vik"))).toBe(false);
  });

  it("carries each wedding's slug as its second line", async () => {
    mount({});
    open();
    expect(await screen.findByText("maya-and-sol")).toBeTruthy();
    expect(screen.getByText("nell-and-jo")).toBeTruthy();
  });

  it("selecting a wedding reports that wedding", async () => {
    const { onSelect } = mount({});
    open();
    fireEvent.pointerUp(await screen.findByText("Nell & Jo"), { button: 0 });
    expect(onSelect).toHaveBeenCalledWith(NELL);
  });

  it("selecting All weddings reports the way back", async () => {
    const { onSelect, onAll } = mount({});
    open();
    fireEvent.pointerUp(await screen.findByText(/all weddings/i), { button: 0 });
    expect(onAll).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("drops the switch list entirely when this is the only wedding", async () => {
    // A "Switch to" heading over an empty list reads as a broken menu. With one
    // wedding the menu is just the way back out.
    const { onAll } = mount({ current: RUTH, weddings: [RUTH] });
    open();
    const back = await screen.findByText(/all weddings/i);
    expect(screen.queryByText(/switch to/i)).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    fireEvent.pointerUp(back, { button: 0 });
    expect(onAll).toHaveBeenCalledOnce();
  });

  it("shows the heading and a separator once there is somewhere to switch to", async () => {
    mount({ current: RUTH, weddings: [RUTH, MAYA] });
    open();
    expect(await screen.findByText(/switch to/i)).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });
});
