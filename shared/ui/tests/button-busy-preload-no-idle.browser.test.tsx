/**
 * `button-busy-preload`, in a browser with no `requestIdleCallback`, as Safari
 * has shipped: a `Button` that carries a `busy` prop still fetches the orb's
 * module before it is ever busy, through the timer `Button` falls back to, and
 * its first wait draws the orb at once.
 *
 * One test, alone in its file: Vitest runs each browser file in a frame of its
 * own, so the module cache this reads is cold, and the idle callback removed
 * here is missing from this frame only.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { Button } from "../src/ui/button";

import "./test-support/tailwind.css";

const idleCallback = globalThis.requestIdleCallback;

beforeAll(() => {
  // @ts-expect-error a browser without it is the case under test.
  delete globalThis.requestIdleCallback;
});

afterAll(() => {
  globalThis.requestIdleCallback = idleCallback;
});

afterEach(() => {
  cleanup();
});

/** Every fetch of the orb's module this frame has made. */
const orbFetches = () =>
  performance.getEntriesByType("resource").filter((entry) => /\/ui\/orb\.tsx\b/.test(entry.name));

it("fetches the orb without an idle callback, and draws it the moment the button is busy", async () => {
  expect(typeof globalThis.requestIdleCallback).toBe("undefined");
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

  setBusy(true);
  expect(button.firstElementChild?.tagName).toBe("CANVAS");
  expect(button.querySelector("span[aria-hidden]")).toBeNull();
  expect(orbFetches()).toHaveLength(1);
});
