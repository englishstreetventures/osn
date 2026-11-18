/**
 * How `Dialog` draws and moves when no app sets its title weight or its scale,
 * held exactly: every computed style `DialogTitle` carries that a plain `<h2>`
 * beside it does not, the title's weight, size and ink in the sheet pulse's
 * share dialog uses, and the scale, time and curve the panel enters from and
 * leaves to.
 *
 * pulse draws this Dialog for its guest list, its share sheet and its
 * discovery filters, and maps neither the title weight nor the motion tokens,
 * so this file is what lets a change to Dialog claim that pulse's dialogs do
 * not move. The one exception is the share sheet below `md`, which slides up
 * and down (`overlay-motion.browser.test.tsx`, "a sheet's slide"); its title
 * is still held here. It imports only what Dialog exported before the title read a
 * token, so it runs on the code before such a change as well as after it, and
 * the snapshot beside it was written by the code before. Rewriting that
 * snapshot with `-u` changes how pulse draws a dialog title: do it only in a
 * pull request that says so in its body and that the owner approves.
 *
 * The title and the plain `<h2>` carry no text, so no height comes from a
 * platform font.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../src/ui/dialog";
import { frames, watchAnimations } from "./test-support/motion";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

/** Gitignored; a rerun of this file draws them again. */
const shot = (name: string) => `__screenshots__/dialog-default.browser.test.tsx/${name}.png`;

/** Jump every running animation to its end, so no value is read part-way. */
function settle() {
  for (const animation of document.getAnimations()) animation.finish();
}

/** Every computed property of `element`, plus any of `names` it does not enumerate. */
function readStyle(element: Element, names: Iterable<string> = []): Map<string, string> {
  const style = getComputedStyle(element);
  const out = new Map<string, string>();
  for (const name of [...Array.from(style), ...names]) out.set(name, style.getPropertyValue(name));
  return out;
}

/** Every property whose value in `ours` differs from `theirs`, with ours. */
function differences(ours: Map<string, string>, theirs: Map<string, string>) {
  const out: Record<string, string> = {};
  const names = [...new Set([...ours.keys(), ...theirs.keys()])];
  names.sort();
  for (const name of names) {
    const value = ours.get(name) ?? "";
    if (value !== (theirs.get(name) ?? "")) out[name] = value;
  }
  return out;
}

describe("DialogTitle with no weight token set", () => {
  it("computes the styles it computed before the token, beside a plain heading", async () => {
    render(() => (
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle data-testid="target" />
          {/* oxlint-disable-next-line jsx-a11y/heading-has-content -- a style baseline, never read out: empty so no height comes from a platform font. */}
          <h2 data-testid="plain" />
        </DialogContent>
      </Dialog>
    ));
    const target = await vi.waitFor(() => screen.getByTestId("target"));
    const plain = screen.getByTestId("plain");
    settle();
    const ours = readStyle(target);
    const dump = differences(ours, readStyle(plain, ours.keys()));

    expect(Object.keys(dump)).toContain("font-weight");
    expect(Object.keys(dump)).toContain("--tw-font-weight");
    expect(dump).toMatchSnapshot("computed style");
  });

  for (const width of [390, 1440] as const) {
    it(`sets the share sheet's title at 600 and 16.8px in the ink, at ${width}px`, async () => {
      await page.viewport(width, 800);
      render(() => (
        <Dialog defaultOpen>
          <DialogContent presentation="sheet">
            <DialogHeader>
              <DialogTitle>Share event</DialogTitle>
            </DialogHeader>
            <p class="p-4">A link anyone can open.</p>
          </DialogContent>
        </Dialog>
      ));
      const title = await vi.waitFor(() => screen.getByRole("heading", { name: "Share event" }));
      settle();
      await frames();
      // Drawn before anything is asserted, so a failing run leaves its picture.
      await page.screenshot({ path: shot(`sheet-${width}`) });
      const style = getComputedStyle(title);
      expect(style.fontWeight).toBe("600");
      // The `--ui-text-md` fallback, 1.05rem, and `--ui-ink` in the test palette.
      expect(style.fontSize).toBe("16.8px");
      expect(style.color).toBe("rgb(26, 26, 34)");
    });
  }
});

describe("Dialog's motion with no scale token set", () => {
  it("enters from 0.96 over 120ms and leaves to 0.98 over 80ms, both on one curve", async () => {
    render(() => (
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>A dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    ));
    const watch = watchAnimations();
    await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const panel = await vi.waitFor(() => screen.getByRole("dialog"));
    await Promise.all(panel.getAnimations().map((a) => a.finished));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 2000 });
    watch.stop();
    const on = (name: string) => watch.started.find((s) => s.target === panel && s.name === name);
    // The contract's arriving curve, which exits ran on before they had a
    // token of their own.
    const curve = "cubic-bezier(0.22, 1, 0.36, 1)";
    expect(on("ui-enter"), "no entry animation").toMatchObject({
      duration: 120,
      easing: curve,
      enterScale: "0.96",
    });
    expect(on("ui-exit"), "no exit animation").toMatchObject({
      duration: 80,
      easing: curve,
      exitScale: "0.98",
    });
  });
});
