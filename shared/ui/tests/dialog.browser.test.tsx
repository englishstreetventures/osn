/**
 * `Dialog` in real Chromium: the title's weight, the panel's shadow, the
 * scrim behind it and the sheet's corners, each read from the contract.
 *
 * A DOM shim can see that a class is there; only a stylesheet can show that
 * Tailwind built a rule for it, that the rule won, and that the token is read
 * where a caller's mapping can reach it. The panel portals to `<body>`, so the
 * title's token is set on the panel itself, the nearest place a caller's
 * mapping can reach it, and the shadow's and the scrim's on `<html>`, where an
 * app maps them.
 *
 * The look of the unset title, every computed style and not just the weight,
 * is held apart in `dialog-default.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../src/ui/dialog";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-elev-2");
  document.documentElement.style.removeProperty("--ui-scrim");
});

/** Gitignored; a rerun of this file draws them again. */
const shot = (name: string) => `__screenshots__/dialog.browser.test.tsx/${name}.png`;

/** Open a dialog, finish its entry, and hand back the panel and the scrim behind it. */
async function openDialog(presentation?: "centred" | "sheet") {
  render(() => (
    <Dialog defaultOpen>
      <DialogContent presentation={presentation}>
        <DialogHeader>
          <DialogTitle>Share event</DialogTitle>
        </DialogHeader>
        <p>Pick where to send it.</p>
      </DialogContent>
    </Dialog>
  ));
  const panel = await vi.waitFor(() => screen.getByRole("dialog"));
  for (const animation of document.getAnimations()) animation.finish();
  // `DialogContent` draws its own overlay just before the panel, in the same portal.
  const scrim = panel.previousElementSibling;
  if (!(scrim instanceof HTMLElement) || getComputedStyle(scrim).position !== "fixed") {
    throw new Error("no overlay drawn before the panel");
  }
  return { panel, scrim };
}

/** The four corners, clockwise from the top left. */
function corners(element: Element): string[] {
  const s = getComputedStyle(element);
  return [
    s.borderTopLeftRadius,
    s.borderTopRightRadius,
    s.borderBottomRightRadius,
    s.borderBottomLeftRadius,
  ];
}

describe("DialogTitle's weight", () => {
  it("follows `--ui-weight-title` set on an ancestor", async () => {
    render(() => (
      <Dialog defaultOpen>
        <DialogContent style={{ "--ui-weight-title": "500" }}>
          <DialogHeader>
            <DialogTitle>Switch profile</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    ));
    const title = await vi.waitFor(() => screen.getByRole("heading", { name: "Switch profile" }));
    for (const animation of document.getAnimations()) animation.finish();
    await page.screenshot({
      path: "__screenshots__/dialog.browser.test.tsx/title-500.png",
      element: screen.getByRole("dialog"),
    });
    expect(getComputedStyle(title).fontWeight).toBe("500");
  });
});

describe("DialogContent's shadow", () => {
  it("follows `--ui-elev-2` where an app maps it", async () => {
    document.documentElement.style.setProperty("--ui-elev-2", "0 0 0 7px rgb(1 2 3)");
    const { panel } = await openDialog();
    const shadow = getComputedStyle(panel).boxShadow;
    expect(shadow.endsWith("rgb(1, 2, 3) 0px 0px 0px 7px")).toBe(true);
    // Tailwind's own `shadow-xl`, which no app mapping reaches.
    expect(shadow).not.toContain("0px 20px 25px -5px");
  });

  it("casts the contract's raised elevation where no app maps it", async () => {
    const { panel } = await openDialog();
    await page.screenshot({ path: shot("shadow-unmapped"), element: panel });
    expect(getComputedStyle(panel).boxShadow).toMatch(/rgba\(0, 0, 0, 0\.12\) 0px 8px 24px 0px$/);
  });
});

describe("DialogOverlay's scrim", () => {
  it("follows `--ui-scrim` where an app maps it", async () => {
    document.documentElement.style.setProperty("--ui-scrim", "rgb(1 2 3 / 0.25)");
    const { scrim } = await openDialog();
    expect(getComputedStyle(scrim).backgroundColor).toBe("rgba(1, 2, 3, 0.25)");
  });

  it("is black at 50% where no app maps it", async () => {
    const { scrim } = await openDialog();
    await page.screenshot({ path: shot("scrim-unmapped") });
    expect(getComputedStyle(scrim).backgroundColor).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("DialogContent's corners", () => {
  // Unmapped, `--ui-radius-sheet` and `--ui-radius-lg` both fall back to 10px.
  // 767 and 768px sit either side of `md`, where the sheet hands over to the card.
  it.each([390, 700, 767])("the sheet is square along the bottom edge at %ipx", async (width) => {
    await page.viewport(width, 900);
    const { panel } = await openDialog("sheet");
    await page.screenshot({ path: shot(`sheet-${width}`) });
    expect(corners(panel)).toEqual(["10px", "10px", "0px", "0px"]);
  });

  it.each([768, 1440])("the sheet is the centred card again from `md`, at %ipx", async (width) => {
    await page.viewport(width, 900);
    const { panel } = await openDialog("sheet");
    await page.screenshot({ path: shot(`sheet-${width}`) });
    expect(corners(panel)).toEqual(["10px", "10px", "10px", "10px"]);
  });

  it.each([390, 700, 1440])("the centred card is round on all four at %ipx", async (width) => {
    await page.viewport(width, 900);
    const { panel } = await openDialog("centred");
    await page.screenshot({ path: shot(`centred-${width}`) });
    expect(corners(panel)).toEqual(["10px", "10px", "10px", "10px"]);
  });
});
