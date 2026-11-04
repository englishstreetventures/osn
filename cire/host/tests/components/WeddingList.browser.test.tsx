import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The wedding list, painted at a phone's width: a wedding's tile holds a long
 * name inside it, and a deleted wedding's row lays its name and Restore side
 * by side on the card's small step. A tile is a `Button`, whose base holds its
 * words to one line, and a card's base is a column, so both depend on a class
 * the call site adds, which only an engine resolves.
 */

// The list reads nothing on render; a restore is the only call, and none is made.
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  redirectToLogin: () => {},
}));

import type { DeletedWeddingSummary, WeddingSummary } from "../../src/components/CreateWeddingForm";
import WeddingList from "../../src/components/WeddingList";

const LONG_NAME =
  "Alexandria Konstantinopoulou and Bartholomew Featherstonehaugh-Cholmondeley at Wollombi";

const WEDDINGS: WeddingSummary[] = [
  {
    id: "wed_long",
    slug: "alexandria-bartholomew",
    displayName: LONG_NAME,
    role: "owner",
    entitlements: [],
    guestCap: 100,
  },
  {
    id: "wed_short",
    slug: "cara-dan",
    displayName: "Cara & Dan",
    role: "owner",
    entitlements: [],
    guestCap: 100,
  },
];

const DELETED: DeletedWeddingSummary[] = [
  {
    id: "wed_gone",
    slug: "eve-finn",
    displayName: "Eve & Finn",
    deletedAt: "2026-10-27T00:00:00.000Z",
    restoreUntil: "2026-11-03T00:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
});

describe("the wedding list at a phone's width", () => {
  it("wraps a long wedding name inside its tile", async () => {
    await page.viewport(390, 844);
    render(() => <WeddingList weddings={WEDDINGS} onSelect={() => {}} onCreated={() => {}} />);
    const name = screen.getByText(LONG_NAME);
    const tile = name.closest("button")!;
    // Nothing runs past the tile's edge, so nothing is cut off.
    expect(tile.scrollWidth).toBeLessThanOrEqual(tile.clientWidth);
    // And the name takes more than one line to say.
    const line = Number.parseFloat(getComputedStyle(name).lineHeight);
    expect(name.getBoundingClientRect().height).toBeGreaterThan(line * 1.5);
  });

  it("lays a deleted wedding's name and Restore side by side on the card's small step", async () => {
    await page.viewport(390, 844);
    render(() => (
      <WeddingList weddings={WEDDINGS} deleted={DELETED} onSelect={() => {}} onCreated={() => {}} />
    ));
    const row = screen.getByText("Eve & Finn").closest("li")!;
    const style = getComputedStyle(row);
    expect(style.flexDirection).toBe("row");
    expect(style.paddingTop).toBe("16px");
    expect(style.borderTopLeftRadius).toBe("16px");
    // A row set on the page's own ground: no fill of its own.
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
});

/*
 * The empty slot (the 2026-11-04 consistency audit, item 9): "Create a
 * wedding" stands in the grid's next cell as a dashed tile, the 14px field
 * corner, the size of a wedding's tile, not a pill under the grid.
 */
describe("the empty slot", () => {
  it("is a dashed 14px tile in the grid, the size of a wedding's tile", async () => {
    await page.viewport(1280, 900);
    render(() => <WeddingList weddings={WEDDINGS} onSelect={() => {}} onCreated={() => {}} />);
    const slot = screen.getByRole("button", { name: "Create a wedding" });
    const tile = screen.getByRole("button", { name: new RegExp(WEDDINGS[0]!.displayName) });
    const style = getComputedStyle(slot);
    expect([style.borderTopStyle, style.borderTopLeftRadius]).toEqual(["dashed", "14px"]);
    expect(slot.closest("ul")).toBe(tile.closest("ul"));
    const [a, b] = [slot.getBoundingClientRect(), tile.getBoundingClientRect()];
    expect([Math.round(a.width), Math.round(a.height)]).toEqual([
      Math.round(b.width),
      Math.round(b.height),
    ]);
  });
});
