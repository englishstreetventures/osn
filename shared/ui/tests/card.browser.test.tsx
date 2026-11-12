/**
 * `CardTitle`'s weight in real Chromium: the title reads `--ui-weight-title`,
 * the contract's title weight, falls back to 600 where nothing sets it, and
 * follows the token wherever it is set above the title, not only on the root.
 *
 * A DOM shim can see that the class is there; only a stylesheet can show that
 * Tailwind built a rule for it, that the rule won, and that the token is read
 * at the title rather than once at the root. A card is not portalled, so the
 * token here is set on a wrapper, where an app's or a section's mapping would
 * reach it.
 *
 * The look of the unset case, every computed style and not just the weight,
 * is held apart in `card-default.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { Card, CardDescription, CardHeader, CardTitle } from "../src/ui/card";
import { frames } from "./test-support/motion";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

/** Gitignored; a rerun of this file draws them again. */
const shot = (name: string) => `__screenshots__/card.browser.test.tsx/${name}.png`;

describe("CardTitle's weight", () => {
  for (const width of [390, 1440] as const) {
    it(`is 600 with no token and follows \`--ui-weight-title\` set on an ancestor, at ${width}px`, async () => {
      await page.viewport(width, 600);
      render(() => (
        <div data-testid="frame" class="flex flex-wrap items-start gap-4 p-4">
          <div>
            <Card class="w-72">
              <CardHeader>
                <CardTitle>Rooftop, Friday</CardTitle>
                <CardDescription>No token set.</CardDescription>
              </CardHeader>
            </Card>
          </div>
          <div style={{ "--ui-weight-title": "500" }}>
            <Card class="w-72">
              <CardHeader>
                <CardTitle>Garden, Saturday</CardTitle>
                <CardDescription>--ui-weight-title: 500 on the wrapper.</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      ));
      await frames();
      // Drawn before anything is asserted, so a failing run leaves its picture.
      await page.screenshot({
        path: shot(`weights-${width}`),
        element: screen.getByTestId("frame"),
      });
      const weight = (name: string) =>
        getComputedStyle(screen.getByRole("heading", { name })).fontWeight;
      expect(weight("Rooftop, Friday")).toBe("600");
      expect(weight("Garden, Saturday")).toBe("500");
    });
  }
});
