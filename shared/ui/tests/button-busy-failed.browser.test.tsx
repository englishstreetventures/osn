/**
 * A busy `Button` whose orb never arrives — the module's fetch failed, as when
 * a deploy has replaced the chunk under a page that is still open. The button
 * still says it is busy, keeps its label and its width, and leaves no
 * unhandled rejection (Vitest fails the run on one).
 *
 * The fetch is failed in the browser, for this file's frame only, so the
 * module cache this reads is cold and the failure is a real one.
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
  render(() => <Button busy>Creating…</Button>);
  const button = screen.getByRole("button", { name: "Creating…" });
  const width = button.getBoundingClientRect().width;
  await expect.poll(() => orbFetches().length, { timeout: 5000 }).toBeGreaterThan(0);
  // Long enough for a module that was going to arrive to have arrived.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(button.querySelector("canvas")).toBeNull();
  const mark = button.firstElementChild!;
  expect(mark.tagName).toBe("SPAN");
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  expect(button.getBoundingClientRect().width).toBe(width);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.textContent).toBe("Creating…");
});
