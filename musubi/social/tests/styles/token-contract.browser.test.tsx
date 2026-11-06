/**
 * Does the token contract actually reach the pixel?
 *
 * Every other check in this repo stops short of this one. The conformance test
 * reads the stylesheet and does arithmetic on values it parses; the unit tier
 * asserts a component carries `base:bg-ui-accent` as a string. Neither can see
 * whether that class **generated any CSS**, whether it survived the cascade, or
 * what colour a browser finally painted.
 *
 * That gap is exactly where a token re-key fails, and it fails silently: a
 * Tailwind utility the scanner cannot resolve emits nothing at all — no error,
 * no warning, no rule. A component would render with no background and every
 * string assertion would still pass.
 *
 * So these tests read `getComputedStyle` in a real engine and compare each
 * primitive's painted colour against the app's OWN token, resolved the same
 * way. That is the claim "`@shared/ui` renders identically after the re-key"
 * reduced to something falsifiable: not "the class is present" but "the colour
 * `bg-ui-accent` paints is the colour `--primary` holds".
 */

import { Button } from "@shared/ui/ui/button";
import { Input } from "@shared/ui/ui/input";
import { render } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import "../../src/App.css";

/** The computed value of a custom property on `<html>`, as the browser sees it. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a colour the way the browser does, by letting it do the resolving:
 * paint the value onto a throwaway element and read it back. A `var()` chain,
 * a hex and an `oklch()` all come out as the same `rgb(...)` string, which is
 * what makes two differently-written colours comparable at all.
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
  // The app sets this on <html> at boot (`src/lib/theme.ts`); a test renders
  // into a bare document, so light is whatever `:root` says.
  document.documentElement.classList.remove("dark");

  /*
   * Kill transitions for the whole file.
   *
   * Every primitive carries `base:transition-colors`, so flipping the theme
   * starts a colour transition and `getComputedStyle` read on the next line
   * returns the value part-way through it — which, at t=0, is the OLD colour.
   * Without this, the dark-mode assertions below fail while the token chain
   * underneath them is entirely correct, and the failure points at the wrong
   * thing: the tokens all flip (verified directly), it is the paint that lags.
   *
   * `!important` and `*` because the point is to remove a variable from the
   * measurement, not to model how the app animates. What the app animates is
   * a question for a test about animation.
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
    // The failure this whole file exists for. An unresolvable utility emits no
    // rule, so the element keeps its initial transparent background and every
    // string-level assertion elsewhere still passes.
    const { getByRole } = render(() => <Button>Save</Button>);
    const background = getComputedStyle(getByRole("button")).backgroundColor;
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    expect(background).not.toBe("transparent");
  });

  it("paints the default button with the app's own `--primary`", () => {
    const { getByRole } = render(() => <Button>Save</Button>);
    expect(getComputedStyle(getByRole("button")).backgroundColor).toBe(paint(token("--primary")));
  });

  it("paints its label with the app's own `--primary-foreground`", () => {
    const { getByRole } = render(() => <Button>Save</Button>);
    expect(getComputedStyle(getByRole("button")).color).toBe(paint(token("--primary-foreground")));
  });

  it("paints the destructive button's ink from `--destructive-foreground`, not white", () => {
    // Before the re-key this variant hard-coded `text-white`, so it ignored the
    // token entirely — which meant the dark-mode contrast fix to
    // `--destructive-foreground` was inert for the one control it was for.
    // In light mode the token IS near-white, so this assertion only bites in
    // dark; it is here so the pair reads together.
    const { getByRole } = render(() => <Button variant="destructive">Delete</Button>);
    expect(getComputedStyle(getByRole("button")).color).toBe(
      paint(token("--destructive-foreground")),
    );
  });

  it("follows `.dark`, because the mapping is aliases rather than literals", () => {
    // A literal in the mapping would pin the light value into both themes. The
    // failure would surface much later as "dark mode ignores the theme", with
    // nothing pointing back at the contract.
    const { getByRole } = render(() => <Button>Save</Button>);
    const button = getByRole("button");
    const light = getComputedStyle(button).backgroundColor;

    document.documentElement.classList.add("dark");
    const dark = getComputedStyle(button).backgroundColor;

    expect(dark).not.toBe(light);
    expect(dark).toBe(paint(token("--primary")));
  });

  it("gives the destructive button legible ink in dark mode", () => {
    // The defect the conformance harness found: near-white on the lightened
    // destructive fill measured 2.89:1. This is the same claim, made against a
    // real paint rather than a parsed stylesheet — and it fails if anyone
    // restores `text-white` on the variant.
    document.documentElement.classList.add("dark");
    const { getByRole } = render(() => <Button variant="destructive">Delete</Button>);
    const style = getComputedStyle(getByRole("button"));

    expect(style.color).toBe(paint(token("--destructive-foreground")));
    expect(style.color).not.toBe("rgb(255, 255, 255)");
  });

  it("keeps component defaults at zero specificity, so a call site still wins", () => {
    // `base:` compiles to `:where(…)`. If that ever stopped being true, every
    // existing `class=` override in both apps would silently stop applying —
    // and no string assertion anywhere would notice.
    const { getByRole } = render(() => <Button class="bg-ui-danger">Save</Button>);
    expect(getComputedStyle(getByRole("button")).backgroundColor).toBe(paint(token("--ui-danger")));
  });

  it("gives a control the app's own radius, which here is a pill", () => {
    // The reason `--ui-radius-control` exists rather than the Button picking
    // one of the sized steps. musubi's house style is pill CTAs (DESIGN.md),
    // and before this token that was `class="rounded-pill"` written out at
    // eighteen call sites. A sized step would have been overridden at every one
    // of them, which is what a missing token looks like from the outside.
    const { getByRole } = render(() => <Button>Save</Button>);
    const radius = Number.parseFloat(getComputedStyle(getByRole("button")).borderTopLeftRadius);

    // A pill's computed radius is clamped to half the box's height, so the
    // assertion is "fully round", not a literal 999px.
    const height = getByRole("button").getBoundingClientRect().height;
    expect(radius).toBeGreaterThanOrEqual(height / 2 - 0.5);
  });

  it("gives a text field the field radius, 8px, while its buttons stay pills", () => {
    // `rounded-ui-field` falls back to `--ui-radius-control`, the pill, when an
    // app maps no field radius. Musubi maps one, so a field takes the 8px
    // corner DESIGN.md gives inputs and does not read as a search box.
    const { getByRole } = render(() => <Input aria-label="Name" />);
    expect(getComputedStyle(getByRole("textbox")).borderTopLeftRadius).toBe("8px");
  });

  it("sizes a control from the contract's scale, not Tailwind's", () => {
    // `text-sm` was Tailwind's 0.875rem until the primitives moved onto the
    // contract. Now it is `--ui-text-base`, which this app maps to its own
    // 14px title step — so a shared button is sized by musubi's type system
    // rather than by the library's.
    const { getByRole } = render(() => <Button>Save</Button>);
    const fontSize = getComputedStyle(getByRole("button")).fontSize;
    expect(fontSize).toBe(
      getComputedStyle(document.documentElement).getPropertyValue("--ui-text-base").trim(),
    );
    // DESIGN.md sets a default Button label at 14px. The line above holds the
    // Button to the contract step; this one holds the step to that size, so a
    // re-mapped `--ui-text-base` fails here too.
    expect(fontSize).toBe("14px");
  });
});

describe("focus in normal colours", () => {
  it("keeps Button's ring and draws no outline, under the app's base focus rule", async () => {
    // `App.css` outlines every `:focus-visible` element from its base layer.
    // Button hides its outline from the utilities layer, which outranks base
    // whatever the specificity, so it shows its ring alone. The same rule
    // written outside `@layer base` would win here and draw a grey outline
    // 2px off the ring as well.
    const { getByRole } = render(() => (
      <div>
        <button type="button">Before</button>
        <Button>Save</Button>
      </div>
    ));
    getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    const button = getByRole("button", { name: "Save" });
    expect(button.matches(":focus-visible")).toBe(true);
    const style = getComputedStyle(button);
    expect(style.outlineStyle).toBe("none");
    expect(style.boxShadow).not.toBe("none");
  });
});

describe("focus in a contrast theme", () => {
  afterEach(async () => {
    await commands.emulateMedia({ forcedColors: "none" });
  });

  it("outlines a button reached from the keyboard, where the theme drops its ring", async () => {
    // `Button` hides its outline only while focused, at zero specificity, so
    // that a contrast theme paints it. A rule in this stylesheet that sets
    // `outline` on `:focus-visible` or on buttons would beat it, and take away
    // the one focus mark the theme leaves.
    await commands.emulateMedia({ forcedColors: "active" });
    const { getByRole } = render(() => (
      <div>
        <button type="button">Before</button>
        <Button>Save</Button>
      </div>
    ));
    getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    const button = getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
    const style = getComputedStyle(button);
    expect([style.outlineStyle, style.outlineWidth]).toEqual(["solid", "2px"]);
    expect(style.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});
