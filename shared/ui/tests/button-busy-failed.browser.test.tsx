/**
 * A busy `Button` whose orb never arrives — the module's fetch failed, as when
 * a deploy has replaced the chunk under a page that is still open. The button
 * still says it is busy, keeps its label and its width, and leaves no
 * unhandled rejection (Vitest fails the run on one). Once the network is back,
 * the next button to turn busy fetches the module again and draws the orb.
 *
 * The fetch is failed in the browser, for this file's frame only, so the
 * module cache this reads is cold and the failure is a real one.
 *
 * A page keeps a module once it has arrived, and nothing a test can reach
 * unloads it. So once the second test has drawn the orb, a repeat of it in the
 * same page (`--repeats`) has no failed fetch to recover from: it checks that a
 * busy button then draws the orb at once. Its fetch count holds because the
 * page keeps the module, whatever `Button` does. The fetch after the failure is
 * checked on the first run only.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { commands } from "vitest/browser";

import { Button } from "../src/ui/button";

import "./test-support/tailwind.css";

const ORB = "**/src/ui/orb.tsx*";

const requests = commands as unknown as {
  failRequests: (pattern: string) => Promise<void>;
  allowRequests: (pattern: string) => Promise<void>;
};

beforeAll(async () => {
  await requests.failRequests(ORB);
});

afterAll(async () => {
  await requests.allowRequests(ORB);
});

afterEach(() => {
  cleanup();
});

/** Every attempt this frame made to fetch the orb's module, failed or not. */
const orbFetches = () =>
  performance.getEntriesByType("resource").filter((entry) => /\/ui\/orb\.tsx\b/.test(entry.name));

it("keeps its label, its busy state and the orb's room when the orb fails to load", async () => {
  // Counted from here: a repeat in the same page waits for its own failed fetch.
  const fetched = orbFetches().length;
  render(() => <Button busy>Creating…</Button>);
  const button = screen.getByRole("button", { name: "Creating…" });
  const width = button.getBoundingClientRect().width;
  await expect.poll(() => orbFetches().length, { timeout: 5000 }).toBeGreaterThan(fetched);
  // The page's first busy button also queues a fetch for idle time, which asks
  // again after a failure. Idle callbacks run in the order they were queued,
  // and this deadline is later than the 2s `Button` gives its own (a full run
  // of the tier can starve idle callbacks), so once this one runs, that fetch
  // has started.
  await new Promise((resolve) => requestIdleCallback(resolve, { timeout: 2500 }));
  // This import starts after every fetch the button started, or joins the one
  // still in flight, so it settles after them: by then the orb has either
  // arrived or never will. It may add one more failed fetch to the count.
  await expect(import("@shared/ui/ui/orb")).rejects.toThrow(
    "Failed to fetch dynamically imported module",
  );
  expect(button.querySelector("canvas")).toBeNull();
  const mark = button.firstElementChild!;
  expect(mark.tagName).toBe("SPAN");
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  expect(button.getBoundingClientRect().width).toBe(width);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.textContent).toBe("Creating…");
});

it("asks for the orb again when a later button is busy", async ({ task }) => {
  // Vitest's index of this repeat; after the first, the page holds the orb. A
  // retry keeps its run's index, so a retry of the first run makes the first
  // run's checks.
  const first = !task.result?.repeatCount;
  // On the first run every one of these failed.
  const fetched = orbFetches().length;
  expect(fetched).toBeGreaterThan(0);
  await requests.allowRequests(ORB);
  render(() => <Button busy>Saving…</Button>);
  const button = screen.getByRole("button", { name: "Saving…" });
  // The first run starts in the room the failed fetch left; a later one, with
  // the orb already drawn.
  expect(button.firstElementChild?.tagName).toBe(first ? "SPAN" : "CANVAS");
  await expect.poll(() => button.querySelector("canvas"), { timeout: 5000 }).not.toBeNull();
  // One fetch more on the first run, and none on a later one.
  await expect.poll(() => orbFetches().length, { timeout: 5000 }).toBe(fetched + (first ? 1 : 0));
});
