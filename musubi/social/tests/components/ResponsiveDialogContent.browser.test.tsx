import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

import "../../src/App.css";

/**
 * The app's dialog is a sheet as wide as the phone below `md`, and a centred
 * card with a width cap at `md` and up. The cap is a prop because a class cap
 * at a call site also caps the sheet: `DialogContent`'s sheet rules are
 * zero-specificity, so any plain `max-w-*` beats them.
 */

afterEach(() => {
  cleanup();
});

function renderDialog(width?: "sm" | "xs") {
  render(() => (
    <Dialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent width={width}>
        <p>sheet body</p>
      </ResponsiveDialogContent>
    </Dialog>
  ));
  // The layout width: the opening zoom scales the painted box for a moment.
  return screen.getByRole("dialog").offsetWidth;
}

describe("<ResponsiveDialogContent /> width", () => {
  it.each([
    ["the default", undefined, 384],
    ['width="xs"', "xs" as const, 320],
  ])("%s fills a phone, and caps the desktop card", async (_label, width, cap) => {
    await page.viewport(390, 844);
    expect(renderDialog(width)).toBe(390);
    cleanup();

    await page.viewport(1440, 900);
    expect(renderDialog(width)).toBe(cap);
  });
});
