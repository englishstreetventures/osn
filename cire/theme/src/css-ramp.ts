/**
 * Reading a colour ramp back out of a stylesheet.
 *
 * cire declares its ramps as custom properties in `global.css` — one block per
 * theme — and its contrast guards assert against those declarations rather than
 * against a table of colours copied into a test. That is deliberate: a copied
 * table is the thing that drifts, and a guard that passes against a stale copy
 * is worse than no guard.
 *
 * This lives in `@cire/theme` rather than beside either guard because the two
 * portals both need it, and a helper duplicated across two test files has
 * exactly the drift problem the guards exist to prevent — `cire/host`'s copy
 * and `cire/vendor`'s had already diverged in their error messages and in
 * whether they took the stylesheet as an argument.
 */

import { parseColor, type Oklch } from "@shared/color";

/**
 * The text between a selector's braces.
 *
 * Brace counting rather than a regex: `@media` and `@layer` nest, and a lazy
 * `\{([^}]*)\}` stops at the first inner `}` and silently truncates the block —
 * which reads as a missing token rather than as a parse bug.
 */
export function cssBlockBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`no block for \`${selector}\``);
  const open = css.indexOf("{", at + selector.length);
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`unbalanced braces after \`${selector}\``);
}

/**
 * Every `oklch()` custom property declared in one block, by name.
 *
 * Only `oklch()` values. A ramp also carries composite tokens — an inner lip,
 * two elevation shadows — which have a colour *inside* them but are not
 * colours, and nothing measuring contrast should try to read one as one.
 */
export function cssRamp(css: string, selector: string): Map<string, Oklch> {
  const out = new Map<string, Oklch>();
  for (const [, name, value] of cssBlockBody(css, selector).matchAll(
    /--([\w-]+):\s*(oklch\([^)]*\))\s*;/g,
  )) {
    const parsed = parseColor(value);
    if (!parsed) throw new Error(`unparseable token --${name}: ${value}`);
    out.set(name, parsed);
  }
  return out;
}
