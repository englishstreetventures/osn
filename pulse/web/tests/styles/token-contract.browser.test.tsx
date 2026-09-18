/**
 * Does the token contract reach the pixel in pulse?
 *
 * The same claim `@musubi/social` makes, and worth making twice: the two apps
 * map the contract onto genuinely different ramps, and the mapping decision
 * that matters here — `--ui-accent` is the neutral `--primary`, not the coral
 * `--pulse-accent` — is one a stylesheet-level test can only check by string.
 * This checks it by colour.
 *
 * The conformance test parses values and does arithmetic; the unit tier asserts
 * a class is present. Neither sees whether the class generated CSS, whether it
 * won the cascade, or what a browser painted. A Tailwind utility the scanner
 * cannot resolve emits nothing at all — no error, no rule — and every
 * string-level assertion still passes.
 */

import { Button } from "@shared/ui/ui/button";
import { render } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import "../../src/app.css";

/** The computed value of a custom property on `<html>`, as the browser sees it. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a colour by letting the browser do it: paint the value onto a
 * throwaway element and read it back. An `oklch()`, a hex and a `var()` chain
 * all come back as the same `rgb(...)`, which is what makes two
 * differently-written colours comparable at all — and pulse writes almost
 * everything in `oklch()`.
 */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

beforeAll(() => {
  document.documentElement.classList.remove("dark");

  /*
   * Kill transitions for the whole file.
   *
   * Every primitive carries `base:transition-colors`, so flipping the theme
   * starts a colour transition and a `getComputedStyle` on the next line reads
   * the value part-way through it — at t=0, the OLD colour. Without this the
   * dark-mode assertions fail while the token chain underneath them is entirely
   * correct, and the failure points at the wrong thing.
   */
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("the contract reaches the pixel", () => {
  it("emits CSS for a contract utility at all", () => {
    const { getByRole } = render(() => <Button>Save</Button>);
    const background = getComputedStyle(getByRole("button")).backgroundColor;
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    expect(background).not.toBe("transparent");
  });

  it("paints the default button with `--primary`, NOT with the coral", () => {
    // The mapping decision, checked as a colour rather than as a string. Pulse
    // carries two accents and the contract has one; sending the coral would
    // repaint every shared button in the app. If someone "fixes" the mapping to
    // point at `--pulse-accent` because it reads more like an accent, this is
    // what catches it.
    const { getByRole } = render(() => <Button>Save</Button>);
    const background = getComputedStyle(getByRole("button")).backgroundColor;

    expect(background).toBe(paint(token("--primary")));
    expect(background).not.toBe(paint(token("--pulse-accent")));
  });

  it("paints its label with the app's own `--primary-foreground`", () => {
    const { getByRole } = render(() => <Button>Save</Button>);
    expect(getComputedStyle(getByRole("button")).color).toBe(paint(token("--primary-foreground")));
  });

  it("follows `.dark`, because the mapping is aliases rather than literals", () => {
    const { getByRole } = render(() => <Button>Save</Button>);
    const button = getByRole("button");
    const light = getComputedStyle(button).backgroundColor;

    document.documentElement.classList.add("dark");
    const dark = getComputedStyle(button).backgroundColor;

    expect(dark).not.toBe(light);
    expect(dark).toBe(paint(token("--primary")));
  });

  it("gives the destructive button legible ink in dark mode", () => {
    // The defect the conformance harness found here: near-white on the
    // lightened destructive fill measured 2.77:1. The variant also used to
    // hard-code `text-white`, so it ignored the token entirely — this fails if
    // either regresses.
    document.documentElement.classList.add("dark");
    const { getByRole } = render(() => <Button variant="destructive">Delete</Button>);
    const style = getComputedStyle(getByRole("button"));

    expect(style.color).toBe(paint(token("--destructive-foreground")));
    expect(style.color).not.toBe("rgb(255, 255, 255)");
  });

  it("keeps component defaults at zero specificity, so a call site still wins", () => {
    // `base:` compiles to `:where(…)`. If that stopped being true, every
    // existing `class=` override in this app would silently stop applying, and
    // no string assertion anywhere would notice.
    const { getByRole } = render(() => <Button class="bg-ui-danger">Save</Button>);
    expect(getComputedStyle(getByRole("button")).backgroundColor).toBe(paint(token("--ui-danger")));
  });
  it("emits `text-success` and `text-warn`, which the app had no utility for", () => {
    // These are new, and they are the reason five call sites could stop writing
    // `text-green-600` and `bg-emerald-500`. A `@theme inline` entry that is
    // dropped or renamed makes Tailwind emit NO rule — no error, no warning —
    // so the label falls back to inherited ink and reads as ordinary text. The
    // raw palette colour it replaced could not fail that way, which is what
    // makes this assertion the price of the change.
    document.documentElement.classList.remove("dark");
    const probeSuccess = document.createElement("span");
    probeSuccess.className = "text-success";
    const probeWarn = document.createElement("span");
    probeWarn.className = "text-warn";
    document.body.append(probeSuccess, probeWarn);

    expect(getComputedStyle(probeSuccess).color).toBe(paint(token("--toast-accent-success")));
    expect(getComputedStyle(probeWarn).color).toBe(paint(token("--toast-accent-warn")));
  });

  it("moves both with the theme, which the palette colours they replaced did not", () => {
    const probe = document.createElement("span");
    probe.className = "text-success";
    document.body.append(probe);

    document.documentElement.classList.remove("dark");
    const light = getComputedStyle(probe).color;
    document.documentElement.classList.add("dark");
    const dark = getComputedStyle(probe).color;

    expect(dark).not.toBe(light);
  });
});
