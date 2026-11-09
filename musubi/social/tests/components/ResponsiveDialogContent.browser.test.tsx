import { Dialog } from "@shared/ui/ui/dialog";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ResponsiveDialogContent } from "../../src/components/ResponsiveDialogContent";

import "../../src/App.css";

/**
 * The app's dialog is a sheet as wide as the phone below `md`, and a centred
 * card with a width cap at `md` and up. The cap is a prop because a class cap
 * at a call site also caps the sheet: `DialogContent`'s sheet rules are
 * zero-specificity, so any plain `max-w-*` beats them.
 *
 * No app dialog has a `Dialog.Trigger`, so focus going back to the control
 * that opened one is this component's job, and Kobalte's focus scope runs only
 * in a real browser.
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

/** A page with one button that opens a dialog, as the app's pages do: no `Dialog.Trigger`. */
function renderOpener(
  options: { removeOpenerOnOpen?: boolean; onCloseAutoFocus?: (event: Event) => void } = {},
) {
  const [open, setOpen] = createSignal(false);
  const [openerShown, setOpenerShown] = createSignal(true);
  render(() => (
    <>
      <Show when={openerShown()}>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (options.removeOpenerOnOpen) setOpenerShown(false);
          }}
        >
          Edit
        </button>
      </Show>
      <button type="button">Elsewhere</button>
      <Dialog open={open()} onOpenChange={setOpen}>
        <ResponsiveDialogContent onCloseAutoFocus={options.onCloseAutoFocus}>
          <input aria-label="Name" />
        </ResponsiveDialogContent>
      </Dialog>
    </>
  ));
}

describe("<ResponsiveDialogContent /> focus", () => {
  it("gives focus back to the control that opened it", async () => {
    await page.viewport(1440, 900);
    renderOpener();
    const opener = screen.getByRole("button", { name: "Edit" });

    await userEvent.click(opener);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("leaves focus to Kobalte when the opener has gone", async () => {
    await page.viewport(1440, 900);
    renderOpener({ removeOpenerOnOpen: true });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });

  it("lets a caller that prevents the default put focus elsewhere", async () => {
    await page.viewport(1440, 900);
    renderOpener({
      onCloseAutoFocus: (event) => {
        event.preventDefault();
        screen.getByRole("button", { name: "Elsewhere" }).focus();
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Elsewhere" })),
    );
  });
});
