/**
 * The conformance harness has to be seen to fail, not just to pass.
 *
 * A contrast guard that only ever goes green is indistinguishable from one
 * that measures nothing — which is exactly what the regex-based harness this
 * replaces would have done against a `var()`-based mapping. Every case below
 * that asserts a failure is there to prove the check can produce one.
 */

import { describe, expect, it } from "vitest";

import { assertContractConformance, checkContractConformance } from "../src/conformance";

/**
 * A mapping in the shape a real app writes: house tokens declared as literals,
 * contract tokens pointing at them through `var()`. Two hops, because that is
 * the shape the old harness could not read.
 */
function stylesheet(overrides: Record<string, string> = {}): string {
  const house: Record<string, string> = {
    "--page": "oklch(100% 0 0)",
    "--panel": "oklch(98% 0 0)",
    "--panel-hi": "oklch(100% 0 0)",
    "--well": "oklch(96% 0 0)",
    "--rule": "oklch(90% 0 0)",
    "--rule-strong": "oklch(60% 0 0)",
    "--body": "oklch(20% 0 0)",
    "--body-dim": "oklch(40% 0 0)",
    "--body-faint": "oklch(55% 0 0)",
    "--brand": "oklch(35% 0.1 250)",
    "--brand-hi": "oklch(28% 0.1 250)",
    "--brand-wash": "oklch(90% 0.03 250)",
    "--brand-ink": "oklch(35% 0.1 250)",
    "--on-brand": "oklch(100% 0 0)",
    "--ok": "oklch(42% 0.13 150)",
    "--warn": "oklch(45% 0.12 80)",
    "--bad": "oklch(45% 0.18 25)",
    "--on-bad": "oklch(100% 0 0)",
    "--ring": "oklch(50% 0.2 260)",
    ...overrides,
  };

  const map = `
    --ui-ground: var(--page);
    --ui-ground-deep: var(--panel);
    --ui-surface: var(--panel);
    --ui-surface-raised: var(--panel-hi);
    --ui-surface-sunk: var(--well);
    --ui-hairline: var(--rule);
    --ui-hairline-strong: var(--rule-strong);
    --ui-ink: var(--body);
    --ui-ink-secondary: var(--body-dim);
    --ui-ink-tertiary: var(--body-faint);
    --ui-accent: var(--brand);
    --ui-accent-strong: var(--brand-hi);
    --ui-accent-soft: var(--brand-wash);
    --ui-accent-ink: var(--brand-ink);
    --ui-on-accent: var(--on-brand);
    --ui-success: var(--ok);
    --ui-warn: var(--warn);
    --ui-danger: var(--bad);
    --ui-on-danger: var(--on-bad);
    --ui-focus: var(--ring);
  `;

  const decls = Object.entries(house)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  return `:root {\n${decls}\n${map}\n}\n`;
}

const ONE_SCOPE = [{ name: "test", selectors: [":root"] }] as const;

describe("checkContractConformance", () => {
  it("passes a mapping that clears every floor", () => {
    expect(checkContractConformance({ css: stylesheet(), scopes: ONE_SCOPE })).toEqual([]);
  });

  it("resolves a two-hop var() chain rather than reading a literal", () => {
    // If the resolver were not following `var()`, every pair would come back
    // unparseable and the suite above would fail for the wrong reason. This
    // asserts the mechanism directly: change the value the chain ENDS at, and
    // the verdict changes.
    const failures = checkContractConformance({
      css: stylesheet({ "--body": "oklch(85% 0 0)" }),
      scopes: ONE_SCOPE,
    });
    expect(failures.some((f) => f.fg === "--ui-ink")).toBe(true);
  });

  it("fails body ink that is too light, naming the ratio", () => {
    const failures = checkContractConformance({
      css: stylesheet({ "--body-dim": "oklch(75% 0 0)" }),
      scopes: ONE_SCOPE,
    });
    const hit = failures.find((f) => f.fg === "--ui-ink-secondary");
    expect(hit).toBeDefined();
    expect(hit?.required).toBe(4.5);
    expect(hit?.ratio).toBeLessThan(4.5);
  });

  it("measures ink against EVERY ground, not just the page", () => {
    // Legible on white, illegible on the sunk well. The naive version of this
    // check — ink against one ground — reports clean.
    const failures = checkContractConformance({
      css: stylesheet({ "--well": "oklch(40% 0 0)" }),
      scopes: ONE_SCOPE,
    });
    expect(failures.some((f) => f.fg === "--ui-ink" && f.bg === "--ui-surface-sunk")).toBe(true);
    expect(failures.some((f) => f.fg === "--ui-ink" && f.bg === "--ui-ground")).toBe(false);
  });

  it("composites translucent ink over its ground before measuring", () => {
    // 20% black over white is ~1.5:1 once composited; a ratio that ignored
    // alpha would read the opaque 20% lightness and call it ~15:1.
    const failures = checkContractConformance({
      css: stylesheet({ "--body": "oklch(20% 0 0 / 0.2)" }),
      scopes: ONE_SCOPE,
    });
    const hit = failures.find((f) => f.fg === "--ui-ink" && f.bg === "--ui-ground");
    expect(hit).toBeDefined();
    expect(hit?.ratio).toBeLessThan(4.5);
    expect(hit?.reason).toContain("compositing");
  });

  it("holds decorative tokens to no floor at all", () => {
    // A hairline is decoration; a card is told apart by its surface, not its
    // edge. An invisible one must not fail the build.
    const failures = checkContractConformance({
      css: stylesheet({ "--rule": "oklch(99.5% 0 0)" }),
      scopes: ONE_SCOPE,
    });
    expect(failures.some((f) => f.fg === "--ui-hairline")).toBe(false);
  });

  it("holds large-text and UI tokens to 3:1, not 4.5:1", () => {
    // ~3.6:1 on white: legal for tertiary ink, illegal for body ink.
    const failures = checkContractConformance({
      css: stylesheet({ "--body-faint": "oklch(60% 0 0)" }),
      scopes: ONE_SCOPE,
    });
    expect(failures.some((f) => f.fg === "--ui-ink-tertiary")).toBe(false);
  });

  it("measures on-fill ink against its fill, never against the page", () => {
    // White on white would be a failure if `--ui-on-accent` were measured
    // against the ground. It is not a combination any component renders.
    const failures = checkContractConformance({ css: stylesheet(), scopes: ONE_SCOPE });
    expect(failures.some((f) => f.fg === "--ui-on-accent" && f.bg === "--ui-ground")).toBe(false);
  });

  it("reports an unmapped token rather than skipping it", () => {
    const css = stylesheet().replace("--ui-ink: var(--body);", "");
    const failures = checkContractConformance({ css, scopes: ONE_SCOPE });
    expect(failures.some((f) => f.reason.includes("not mapped"))).toBe(true);
  });

  it("honours an explicit waiver", () => {
    const css = stylesheet().replace("--ui-ink: var(--body);", "");
    const failures = checkContractConformance({
      css,
      scopes: ONE_SCOPE,
      waived: { "--ui-ink": "deliberately absent, for this test" },
    });
    expect(failures.some((f) => f.fg === "--ui-ink")).toBe(false);
  });

  it("catches a cyclic var() chain instead of recursing until the stack dies", () => {
    const css = stylesheet({ "--body": "var(--body-alias)" }).replace(
      ":root {",
      ":root {\n  --body-alias: var(--body);",
    );
    const failures = checkContractConformance({ css, scopes: ONE_SCOPE });
    expect(failures.some((f) => f.fg === "--ui-ink" && f.reason.includes("cyclic"))).toBe(true);
  });

  it("refuses a translucent ground, because what is behind it is unknowable", () => {
    const failures = checkContractConformance({
      css: stylesheet({ "--panel": "oklch(98% 0 0 / 0.6)" }),
      scopes: ONE_SCOPE,
    });
    expect(failures.some((f) => f.bg === "--ui-surface" && f.reason.includes("opaque"))).toBe(true);
  });

  it("does not merge `:root[data-theme]` declarations into the bare `:root` scope", () => {
    // The selector-matching trap: a naive `indexOf(":root")` also matches the
    // `:root` inside `:root[data-theme="light"]`, silently folding the light
    // theme into the dark one and measuring a palette neither theme renders.
    const css = stylesheet() + `:root[data-theme="light"] {\n  --body: oklch(97% 0 0);\n}\n`;
    expect(checkContractConformance({ css, scopes: ONE_SCOPE })).toEqual([]);
  });

  it("applies scopes in cascade order, later selectors winning", () => {
    const css = stylesheet() + `:root[data-theme="light"] {\n  --body: oklch(96% 0 0);\n}\n`;
    const failures = checkContractConformance({
      css,
      scopes: [{ name: "light", selectors: [":root", ':root[data-theme="light"]'] }],
    });
    expect(failures.some((f) => f.fg === "--ui-ink")).toBe(true);
  });

  it("throws on a selector that matches no block, rather than asserting about nothing", () => {
    expect(() =>
      checkContractConformance({
        css: stylesheet(),
        scopes: [{ name: "absent", selectors: [".theme-nope"] }],
      }),
    ).toThrow(/no block matches/);
  });
});

describe("assertContractConformance", () => {
  it("is silent on a conforming mapping", () => {
    expect(() => assertContractConformance({ css: stylesheet(), scopes: ONE_SCOPE })).not.toThrow();
  });

  it("names every failing pair, its scope and its ratio", () => {
    let message = "";
    try {
      assertContractConformance({
        css: stylesheet({ "--body-dim": "oklch(80% 0 0)" }),
        scopes: ONE_SCOPE,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("--ui-ink-secondary");
    expect(message).toContain("[test]");
    expect(message).toMatch(/\d+\.\d+:1/);
  });
});
