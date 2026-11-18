/**
 * A `Button` that carries a `busy` prop fetches the orb's module once it has
 * mounted, before it is ever busy, so its first wait draws the orb at once
 * rather than a blank 20px while the module loads.
 *
 * One test, alone in its file: Vitest runs each browser file in a frame of its
 * own, so the module cache this reads is cold whatever else runs or is
 * filtered out.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";

import { Button } from "../src/ui/button";

import "./test-support/tailwind.css";

afterEach(() => {
  cleanup();
});

/** Every fetch of the orb's module this frame has made. */
const orbFetches = () =>
  performance.getEntriesByType("resource").filter((entry) => /\/ui\/orb\.tsx\b/.test(entry.name));

it("fetches the orb for a button that can be busy, and draws it the moment it is", async () => {
  const [busy, setBusy] = createSignal(false);
  render(() => <Button busy={busy()}>Save</Button>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.children).toHaveLength(0);

  await expect.poll(() => orbFetches().length, { timeout: 5000 }).toBe(1);
  // The module this test imports is the one the button fetched, so once this
  // resolves the module has run and the button's own import has settled too.
  await import("../src/ui/orb");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(button.children).toHaveLength(0);
  expect(button.hasAttribute("aria-busy")).toBe(false);

  setBusy(true);
  expect(button.firstElementChild?.tagName).toBe("CANVAS");
  expect(button.querySelector("span[aria-hidden]")).toBeNull();
  expect(orbFetches()).toHaveLength(1);
});
