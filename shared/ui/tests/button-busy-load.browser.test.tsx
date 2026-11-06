/**
 * The first time a `Button` is busy on a page: the orb's module is fetched
 * then and not before, and the button's width holds while it arrives.
 *
 * One test, alone in its file: Vitest runs each browser file in a frame of its
 * own, so the module cache this reads is cold whatever else runs or is
 * filtered out. A Button that carries no `busy` prop at all, as on every pulse
 * page, must never fetch it.
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

/** Let idle callbacks and a few frames run, so a fetch scheduled for idle time has started. */
async function idle() {
  await new Promise((resolve) => requestIdleCallback(resolve, { timeout: 500 }));
  for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
}

it("fetches the orb only for a busy button, and keeps its width while the orb arrives", async () => {
  render(() => <Button>Save</Button>);
  await idle();
  expect(orbFetches()).toHaveLength(0);
  cleanup();

  render(() => <Button busy>Creating…</Button>);
  const button = screen.getByRole("button", { name: "Creating…" });
  const mark = button.firstElementChild!;
  expect(mark.tagName).toBe("SPAN");
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  const waiting = button.getBoundingClientRect().width;
  const markBox = mark.getBoundingClientRect();
  expect([markBox.width, markBox.height]).toEqual([20, 20]);

  await expect.poll(() => button.querySelector("canvas"), { timeout: 5000 }).not.toBeNull();
  expect(button.firstElementChild?.tagName).toBe("CANVAS");
  expect(button.getBoundingClientRect().width).toBe(waiting);
  expect(orbFetches()).toHaveLength(1);
});
