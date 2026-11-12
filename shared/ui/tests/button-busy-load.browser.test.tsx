/**
 * The first time a `Button` is busy on a page: the orb's module is fetched
 * then and not before, and the button's width holds while it arrives.
 *
 * One test, alone in its file: Vitest runs each browser file in a frame of its
 * own, so the module cache this reads is cold whatever else runs or is
 * filtered out. A Button that carries no `busy` prop at all, as on every pulse
 * page, must never fetch it.
 *
 * A page keeps a module once it has arrived, and nothing a test can reach
 * unloads it, so a repeat of the test in the same page (`--repeats`) finds the
 * orb already there. A repeat checks that the busy button then draws the orb
 * at once, at the room's size. Its fetch counts hold because the page keeps the
 * module, whatever `Button` does. The orb's room, the width while the orb
 * arrives, and when its fetch starts are checked on the first run only.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";

import { Button } from "../src/ui/button";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

/** Every fetch of the orb's module this frame has made. */
const orbFetches = () =>
  performance.getEntriesByType("resource").filter((entry) => /\/ui\/orb\.tsx\b/.test(entry.name));

/**
 * Wait for the page's next idle period, or 2.5s where the page is never idle
 * (a full run of the tier can starve idle callbacks for longer than a test's
 * timeout). Idle callbacks run in the order they were queued, and this
 * deadline is later than the 2s `Button` gives its own, so one a button queued
 * as it mounted has run, and any fetch it starts has started, by then.
 */
const idle = () => new Promise((resolve) => requestIdleCallback(resolve, { timeout: 2500 }));

it("fetches the orb only for a busy button, and keeps its width while the orb arrives", async ({
  task,
}) => {
  // Vitest's index of this repeat. A retry keeps its run's index, so a retry
  // of the first run makes the first run's checks.
  const first = !task.result?.repeatCount;
  render(() => <Button>Save</Button>);
  await idle();
  expect(orbFetches()).toHaveLength(first ? 0 : 1);
  cleanup();

  // A fetch's entry is written once it ends, so a count alone can miss one
  // still in flight; its start time cannot.
  const busyAt = performance.now();
  render(() => <Button busy>Creating…</Button>);
  const button = screen.getByRole("button", { name: "Creating…" });
  const mark = button.firstElementChild!;
  expect(mark.tagName).toBe(first ? "SPAN" : "CANVAS");
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  const waiting = button.getBoundingClientRect().width;
  const markBox = mark.getBoundingClientRect();
  expect([markBox.width, markBox.height]).toEqual([20, 20]);

  await expect.poll(() => button.querySelector("canvas"), { timeout: 5000 }).not.toBeNull();
  expect(button.firstElementChild?.tagName).toBe("CANVAS");
  expect(button.getBoundingClientRect().width).toBe(waiting);
  expect(orbFetches()).toHaveLength(1);
  // The one fetch started once the button turned busy, not at idle time before.
  expect(orbFetches().filter((entry) => entry.startTime >= busyAt)).toHaveLength(first ? 1 : 0);
});
