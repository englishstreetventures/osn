import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { DemoModal } from "../../../src/components/demo/DemoModal";

/*
 * The demo sheet's structure, at the only tier this package has.
 *
 * `@cire/landing` declares a single happy-dom project, so nothing here can see
 * a computed style, a paint order or a transition. What it can see is the class
 * contract the real behaviour rests on — and for the close chip that contract
 * is the whole of it: the chip is a positioned box that must outrank the
 * positioned dietary pills the demo's RSVP form renders below it, and tree
 * order puts the pills last.
 *
 * The measurement behind it lives in
 * `cire/invites/tests/components/DietaryPresets.browser.test.tsx`, against the
 * guest sheet, which has a real browser to run in. This is the cheap guard that
 * the class survives an edit to the list.
 */

afterEach(cleanup);

function mount() {
  return render(() => (
    <DemoModal open={true} onClose={() => {}}>
      <p>body</p>
    </DemoModal>
  ));
}

describe("DemoModal", () => {
  it("ranks the close chip above the panel's contents", () => {
    const { getByLabelText } = mount();
    const close = getByLabelText("Close");
    const classes = close.className.split(/\s+/);
    expect(classes).toContain("absolute");
    expect(classes).toContain("z-10");
  });

  it("keeps the close chip a child of the panel", () => {
    // It is pinned to the panel's corner, so it has to be positioned against
    // the panel rather than against anything the caller renders inside.
    const { getByRole, getByLabelText } = mount();
    const panel = getByRole("dialog", { hidden: true });
    expect(panel.contains(getByLabelText("Close"))).toBe(true);
  });

  it("names the dialog through its caller's title", () => {
    const { getByRole } = render(() => (
      <DemoModal open={true} onClose={() => {}} labelledBy="demo-title">
        <h2 id="demo-title">Respond</h2>
      </DemoModal>
    ));
    expect(getByRole("dialog", { hidden: true }).getAttribute("aria-labelledby")).toBe(
      "demo-title",
    );
  });
});
