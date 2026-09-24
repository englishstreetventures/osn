/**
 * The token list in `index.ts` and the aliases in `tokens.css` are two
 * statements of the same contract, and the drift they can develop is the exact
 * drift this package exists to prevent elsewhere: a token added to one and not
 * the other. An app would map a name no utility reads, or a utility would read
 * a name no conformance test asserts — both silent.
 *
 * So the duplication is deliberate (a regex over CSS would happily find a token
 * in a comment) and guarded.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALL_COLOR_TOKENS,
  CONTRACT_SCALAR_TOKENS,
  CONTRACT_SCALES,
  contrastPairs,
} from "../src/index";

const RAW = readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8");

/**
 * The stylesheet with its comments removed.
 *
 * Every assertion below is about what the file *declares*, and this file's
 * docblocks quote the very things they warn against — an example `@import
 * "tailwindcss"` showing a consumer's setup, a `var(--ui-focus-width)` showing
 * how a scalar token is read. Two of these tests failed on that prose before
 * the strip existed, which is a fair warning about matching CSS with a regex.
 */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--color-ui-x: var(--ui-x, …)` → `--ui-x`, taken only from inside `@theme`. */
function aliasedTokens(): Set<string> {
  const open = CSS.indexOf("@theme");
  expect(open).toBeGreaterThan(-1);
  const brace = CSS.indexOf("{", open);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = CSS.slice(brace + 1, end);
  return new Set([...body.matchAll(/var\(\s*(--ui-[\w-]+)\s*,/g)].map((m) => m[1]));
}

describe("tokens.css agrees with the exported token list", () => {
  it("aliases every colour token the contract declares", () => {
    const aliased = aliasedTokens();
    const missing = ALL_COLOR_TOKENS.filter((t) => !aliased.has(t));
    expect(missing).toEqual([]);
  });

  it("declares no colour alias the token list does not know about", () => {
    const known = new Set<string>([
      ...ALL_COLOR_TOKENS,
      ...CONTRACT_SCALAR_TOKENS.radius,
      ...CONTRACT_SCALAR_TOKENS.fontFamily,
      // The scale namespaces. `measure` breaks the `--ui-<key>-<step>` pattern
      // because Tailwind's namespace is `--container-*` while the role is a
      // measure; the contract is named for the role, the alias for Tailwind.
      ...Object.keys(CONTRACT_SCALES.text).map((s) => `--ui-text-${s}`),
      ...Object.keys(CONTRACT_SCALES.tracking).map((s) => `--ui-tracking-${s}`),
      ...Object.keys(CONTRACT_SCALES.leading).map((s) => `--ui-leading-${s}`),
      ...Object.keys(CONTRACT_SCALES.measure).map((s) => `--ui-measure-${s}`),
    ]);
    const extra = [...aliasedTokens()].filter((t) => !known.has(t));
    expect(extra).toEqual([]);
  });

  it("gives every alias a fallback, so an unmapped app still renders", () => {
    // `var(--ui-x)` with no fallback resolves to nothing and the declaration
    // is dropped — an unmapped app would render transparent text rather than
    // legible-but-neutral text.
    const open = CSS.indexOf("@theme");
    const bare = [...CSS.slice(open).matchAll(/var\(\s*(--ui-[\w-]+)\s*\)/g)].map((m) => m[1]);
    expect(bare).toEqual([]);
  });

  it("declares a fallback for every scalar token outside @theme", () => {
    for (const token of [
      ...CONTRACT_SCALAR_TOKENS.focus,
      ...CONTRACT_SCALAR_TOKENS.motion,
      ...CONTRACT_SCALAR_TOKENS.elevation,
    ]) {
      expect(CSS).toContain(`${token}:`);
    }
  });

  it("ships the two directives consumers would otherwise each declare", () => {
    // Proven to propagate through a bare package specifier in englishstventures/osn#1041.
    expect(CSS).toMatch(/@custom-variant base \(:where\(&\)\);/);
    expect(CSS).toMatch(/@source "\.\.\/\.\.\/ui\/src";/);
    expect(CSS).toMatch(/@source "\.\.\/\.\.\/\.\.\/osn\/auth-ui\/src";/);
  });

  it("never imports tailwindcss itself", () => {
    // Doing so would emit preflight a second time in every consuming app.
    expect(CSS).not.toMatch(/@import\s+["']tailwindcss["']/);
  });

  it("sets no `--default-*` key", () => {
    // `cire/host` sets `--default-font-family`; a package setting the same key
    // would fight it, and which one won would depend on import order.
    expect(CSS).not.toMatch(/--default-[\w-]+\s*:/);
  });

  it("uses `@theme inline`, which is what makes a nested theme scope work", () => {
    expect(CSS).toMatch(/@theme\s+inline\s*\{/);
  });
});

describe("contrastPairs", () => {
  it("measures each body ink against all five grounds and surfaces", () => {
    const pairs = contrastPairs().filter((p) => p.fg === "--ui-ink");
    expect(pairs).toHaveLength(5);
    expect(pairs.every((p) => p.min === 4.5)).toBe(true);
  });

  it("never measures on-fill ink against a page ground", () => {
    const wrong = contrastPairs().filter(
      (p) => p.fg === "--ui-on-accent" && p.bg.startsWith("--ui-ground"),
    );
    expect(wrong).toEqual([]);
  });

  it("asserts nothing about decorative tokens", () => {
    const decorative = contrastPairs().filter(
      (p) => p.fg === "--ui-hairline" || p.fg === "--ui-accent-soft",
    );
    expect(decorative).toEqual([]);
  });
});
