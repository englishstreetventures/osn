/**
 * Does the token contract reach the pixel on the guest site?
 *
 * Every other check stops short of this one. `design-token-contract.test.ts`
 * parses the stylesheet and does arithmetic on values it reads; the unit tier
 * asserts a component carries `base:bg-ui-accent` as a string. Neither can see
 * whether that class **generated any CSS**, whether it survived the cascade, or
 * what a browser finally painted — and a Tailwind utility the scanner cannot
 * resolve emits nothing at all. No error, no rule, and every string assertion
 * still green.
 *
 * That gap matters more here than anywhere else in the repo, because `@cire/ui`
 * lives in a different package from the stylesheet that themes it. The chain is
 * four links long — the component's `base:bg-ui-accent`, the contract's
 * `--color-ui-accent: var(--ui-accent, …)`, this app's
 * `--ui-accent: var(--color-gold)`, and the gold itself — and three of them
 * are in files the component never mentions.
 */

import Button from "@cire/ui/button";
import { render } from "@solidjs/testing-library";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/** A colour resolved by the browser, so an `oklch()` and a `var()` chain compare. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

beforeAll(() => {
  // Every `@cire/ui` component carries `transition-colors`, so a hover-state
  // read taken immediately after a class change returns the PRE-transition
  // colour. Removing the variable is the point; how the app animates is a
  // question for a test about animation.
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

describe("the contract reaches the pixel", () => {
  it("emits CSS for a contract utility at all", () => {
    const { getByRole } = render(() => <Button variant="cta">Open invitation</Button>);
    expect(getComputedStyle(getByRole("button")).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("draws the call to action in the invite's own gold", () => {
    // The whole four-link chain, checked as a colour rather than as a string:
    // `base:text-ui-accent-ink` on a component in another package resolves to
    // `--color-gold-ink` in this app's stylesheet.
    const { getByRole } = render(() => <Button variant="cta">Open invitation</Button>);
    const style = getComputedStyle(getByRole("button"));

    expect(style.color).toBe(paint(token("--color-gold-ink")));
    expect(style.borderTopColor).toBe(paint(token("--color-gold")));
  });

  it("leaves the call to action unfilled at rest, so a photograph stays the loudest thing", () => {
    // The reason `cta` exists rather than reusing `primary`. If someone
    // "simplifies" the variant to the portals' filled primary, this is what
    // notices — and it notices before anyone sees a gold slab on an invite.
    const { getByRole } = render(() => <Button variant="cta">Open invitation</Button>);
    expect(getComputedStyle(getByRole("button")).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("follows an organiser's palette, because the mapping aliases `--color-*`", () => {
    // The claim the whole invite mapping turns on. `paletteRootVars` injects a
    // derived palette as `--color-*` overrides on <html> at runtime; a literal
    // in the mapping would pin the evergreen fallback into every wedding, and
    // nothing short of this test would catch it.
    const { getByRole } = render(() => <Button variant="cta">Open invitation</Button>);
    const before = getComputedStyle(getByRole("button")).borderTopColor;

    document.documentElement.style.setProperty("--color-gold", "rgb(1, 2, 3)");
    const after = getComputedStyle(getByRole("button")).borderTopColor;
    document.documentElement.style.removeProperty("--color-gold");

    expect(after).not.toBe(before);
    expect(after).toBe("rgb(1, 2, 3)");
  });

  it("keeps component defaults at zero specificity, so a call site still wins", () => {
    // `base:` compiles to `:where(…)`. Every `class=` override in this app
    // depends on it, and no string assertion anywhere would notice it changing.
    const { getByRole } = render(() => (
      <Button variant="cta" class="border-error">
        Open invitation
      </Button>
    ));
    expect(getComputedStyle(getByRole("button")).borderTopColor).toBe(
      paint(token("--color-error")),
    );
  });

  it("carries a focus ring of its own, which this app's global rule does not supply to it first", () => {
    const { getByRole } = render(() => <Button variant="cta">Open invitation</Button>);
    const button = getByRole("button");
    button.focus();
    const style = getComputedStyle(button);
    expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThan(0);
    expect(style.outlineStyle).not.toBe("none");
  });
});
