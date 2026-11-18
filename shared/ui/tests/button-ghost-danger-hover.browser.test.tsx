/**
 * `Button` `ghostDanger`, hovered: red ink with no fill behind it.
 *
 * A fill under the red would put `--ui-danger` text on `--ui-surface-sunk`,
 * which Musubi's light theme measures at 4.34:1, under the 4.5:1 floor for
 * text. The variant marks hover by its ink alone, so these read the computed
 * colours in real Chrome with the pointer on the button: the background stays
 * transparent and the ink is the danger token. The contrast of the real
 * Musubi tokens is measured in `@musubi/social`'s
 * `tests/styles/ghost-danger-hover.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { Button } from "../src/ui/button";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

/** Jump every running transition to its end, so no value is read part-way. */
function settle() {
  for (const animation of document.getAnimations()) animation.finish();
}

/** Resolve a colour the way the browser does: paint it and read it back. */
function resolve(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

describe("ghostDanger, hovered", () => {
  it.each(["default", "sm", "icon"] as const)(
    "size %s paints red ink and no fill",
    async (size) => {
      render(() => (
        <Button variant="ghostDanger" size={size} aria-label="Remove">
          Remove
        </Button>
      ));
      const button = screen.getByRole("button", { name: "Remove" });
      const rest = getComputedStyle(button).color;
      expect(rest).toBe(resolve("var(--ui-ink-secondary)"));

      await userEvent.hover(button);
      settle();
      expect(button.matches(":hover")).toBe(true);
      const style = getComputedStyle(button);
      expect(style.color).toBe(resolve("var(--ui-danger)"));
      expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    },
  );
});
