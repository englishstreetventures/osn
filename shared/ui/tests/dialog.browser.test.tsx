/**
 * `DialogTitle`'s weight in real Chromium: the title reads `--ui-weight-title`,
 * the contract's title weight, and follows it wherever it is set above the
 * title, not only on the root.
 *
 * A DOM shim can see that the class is there; only a stylesheet can show that
 * Tailwind built a rule for it, that the rule won, and that the token is read
 * at the title rather than once at the root. The panel portals to `<body>`, so
 * the token here is set on the panel itself, the nearest place a caller's
 * mapping can reach it.
 *
 * The look of the unset case, every computed style and not just the weight,
 * is held apart in `dialog-default.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../src/ui/dialog";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

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
