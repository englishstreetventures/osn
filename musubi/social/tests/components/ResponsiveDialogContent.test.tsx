// @vitest-environment happy-dom
import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

afterEach(() => {
  cleanup();
});

/** Every app dialog routes through this component. The sheet defaults are
 *  `base:`-prefixed because they come from `DialogContent`'s own `presentation`
 *  variant — zero specificity — and a caller's classes must still land after
 *  them so a call site's plain utility wins the merge. */
describe("<ResponsiveDialogContent /> — sheet-class contract", () => {
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
