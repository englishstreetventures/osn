// @vitest-environment happy-dom
import { Dialog, DialogContent } from "@shared/ui/ui/dialog";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { Show, type JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { ViewStep } from "../src/ViewParts";
import { withoutAnimations } from "./helpers/motion";

withoutAnimations();
afterEach(cleanup);

/** `children` in an open sheet, inside a root `div` as every view has. */
function inSheet(children: JSX.Element) {
  render(() => (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent presentation="sheet">
        <div data-testid="view">{children}</div>
      </DialogContent>
    </Dialog>
  ));
  return screen.getByTestId("view");
}

describe("ViewStep in a dialog", () => {
  // A done line ("You're all set.") commits nothing and offers no way out:
  // the host closes the dialog, so the sheet ends with the line.
  it("draws no footer when it has neither Cancel nor an action", () => {
    const view = inSheet(
      <ViewStep host="dialog">
        <p>You're all set.</p>
      </ViewStep>,
    );
    expect(view.children).toHaveLength(1);
    expect(view.textContent).toBe("You're all set.");
  });

  // A step whose body holds nothing (a step-up sheet with no line and no
  // other factor) draws no empty padded band between the two hairlines.
  it("draws no body when nothing in it shows", () => {
    const view = inSheet(
      <ViewStep host="dialog" onCancel={() => {}} action={<button type="button">Go</button>}>
        <Show when={false}>
          <p>Hidden</p>
        </Show>
      </ViewStep>,
    );
    expect(view.children).toHaveLength(1);
    expect([...view.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Cancel",
      "Go",
    ]);
  });
});
