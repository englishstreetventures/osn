// @vitest-environment happy-dom
import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

afterEach(() => {
  cleanup();
});

/** Every app dialog routes through this component, and the bottom-sheet face it
 *  selects is pure classes, so the contract is locked with class assertions
 *  (same pattern as MobileNav.test.tsx's shell test). The classes are
 *  `base:`-prefixed because they come from `DialogContent`'s own `presentation`
 *  variant — zero specificity, so a call site's plain utility still wins. */
describe("<ResponsiveDialogContent /> — sheet-class contract", () => {
  it("carries the mobile bottom-sheet tokens, and inherits the desktop card radius", () => {
    render(() => (
      <Dialog open onOpenChange={() => {}}>
        <ResponsiveDialogContent>
          <p>sheet body</p>
        </ResponsiveDialogContent>
      </Dialog>
    ));
    const content = screen.getByText("sheet body").closest("[role=dialog]") as HTMLElement;
    expect(content).not.toBeNull();
    // `rounded-ui-lg` rather than `rounded-card`: App.css maps
    // `--ui-radius-lg: var(--radius-card)`, so `DialogContent`'s own default
    // already resolves to musubi's 16px card radius and the wrapper does not
    // need to restate it. Asserting the contract class is what keeps that
    // true — if the mapping is ever dropped, this is the test that notices.
    for (const token of [
      "rounded-ui-lg",
      "max-md:base:bottom-0",
      "max-md:base:top-auto",
      "max-md:base:max-w-none",
      "max-md:base:max-h-[85dvh]",
      "max-md:base:overflow-y-auto",
      "max-md:base:rounded-t-ui-sheet",
      "max-md:base:rounded-b-none",
      "max-md:base:pb-[max(0px,env(safe-area-inset-bottom))]",
    ]) {
      expect(content.className).toContain(token);
    }
  });

  it("appends caller classes after the sheet defaults so they win merges", () => {
    render(() => (
      <Dialog open onOpenChange={() => {}}>
        <ResponsiveDialogContent class="max-w-sm p-0">
          <p>sheet body</p>
        </ResponsiveDialogContent>
      </Dialog>
    ));
    const content = screen.getByText("sheet body").closest("[role=dialog]") as HTMLElement;
    const cls = content.className;
    expect(cls.indexOf("max-w-sm")).toBeGreaterThan(cls.indexOf("max-md:base:bottom-0"));
    expect(cls).toContain("p-0");
  });
});
