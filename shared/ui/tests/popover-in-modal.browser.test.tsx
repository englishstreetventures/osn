/**
 * A popover opened from inside a `Modal`.
 *
 * `Modal` is `<dialog>` + `showModal()`, so it paints in the **top layer** —
 * above every stacking context in the document, by definition. `Popover`
 * portals its panel to `<body>` and positions it with a `z-index`. Those two
 * facts together mean the panel lands *behind* the dialog however large that
 * `z-index` is: rendered, measurable, announced by a screen reader, and
 * completely unclickable.
 *
 * `PopoverContent` answers it by portalling into the open `dialog:modal` rather
 * than into `<body>`, so the panel inherits the dialog's own top-layer
 * promotion and Kobalte's positioning is left alone. Promoting the panel
 * separately, with the native `popover` attribute, was tried and does not work:
 * Kobalte positions with `position: absolute`, whose containing block changes
 * the moment an element is promoted, and the panel ends up painted where the
 * hit test never reaches.
 *
 * Nothing below this tier can catch any of it. happy-dom has no top layer and no
 * layout, so every DOM assertion about the panel passes while the real thing is
 * invisible.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { Modal } from "../src/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "../src/ui/popover";

import "./test-support/tailwind.css";

function mount(props: { frame?: boolean } = {}) {
  const [open, setOpen] = createSignal(true);
  const result = render(() => (
    <Modal open={open()} onClose={() => setOpen(false)} label="Test dialog" frame={props.frame}>
      <Popover>
        <PopoverTrigger>Open the panel</PopoverTrigger>
        <PopoverContent>
          <button type="button" data-testid="panel-action">
            Inside the panel
          </button>
        </PopoverContent>
      </Popover>
    </Modal>
  ));
  const dialog = result.container.querySelector("dialog");
  if (!dialog) throw new Error("no dialog rendered");
  return { ...result, setOpen, dialog };
}

afterEach(() => {
  // A `showModal()` dialog is in the top layer, so it survives an `afterEach`
  // that only empties the render container — and the next test then mounts
  // behind a survivor and fails describing a fault in the component.
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  for (const p of document.querySelectorAll("[data-kb-top-layer]")) p.remove();
  cleanup();
});

/**
 * Open the panel and wait for its entrance transition to settle.
 *
 * `screen`, not the render result's own queries: the panel portals to `<body>`,
 * outside the container those are scoped to, so a scoped lookup reports it
 * missing when it is merely elsewhere. And a real pointer sequence rather than
 * `.click()`, because Kobalte's trigger opens on pointer events.
 */
async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: "Open the panel" }));
  await settle();
}

/** Wait for the panel's entrance transition to settle before measuring. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe("Popover inside Modal", () => {
  it("puts the panel where a click on it actually lands", async () => {
    mount();
    await openPanel();

    const action = screen.getByTestId("panel-action");
    const rect = action.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);

    // The assertion the whole file exists for. `elementFromPoint` answers with
    // whatever the user's pointer would hit — the dialog, when the panel is
    // stuck under it, and the panel's own content when the promotion worked.
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(action.contains(hit) || action === hit).toBe(true);
  });

  it("keeps the panel reachable by a screen reader", async () => {
    // A modal dialog marks everything outside itself `aria-hidden`, and the
    // panel portals outside. `data-kb-top-layer` is what exempts it from that
    // walk — visible and unannounced is the worst of the failure modes, because
    // nothing about it looks wrong.
    mount();
    await openPanel();

    for (
      let node = screen.getByTestId("panel-action").parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
    }
  });

  it("is still clipped inside a `frame` modal", async () => {
    // Not the behaviour anyone wants — this records where the fix currently
    // stops. `frame` makes the dialog `overflow-clip` and moves scrolling to
    // a child, so mounting the panel into that dialog clears the top layer only
    // to land inside the clip. Invert this assertion when englishstventures/osn#1089 is
    // fixed; a bare `toBe(true)` would otherwise start passing silently and
    // nobody would know the limitation had gone.
    mount({ frame: true });
    await openPanel();

    const action = screen.getByTestId("panel-action");
    const rect = action.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(action.contains(hit) || action === hit).toBe(false);
  });

  it("still closes when the trigger is pressed again", async () => {
    // The promotion must not fight the library's own open/closed state: a panel
    // shown into the top layer by hand, and hidden only by Solid unmounting it,
    // is a panel that reopens with stale contents or refuses to close at all.
    mount();
    await openPanel();
    expect(screen.queryByTestId("panel-action")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Open the panel" }));
    await settle();
    expect(screen.queryByTestId("panel-action")).toBeNull();
  });
});
