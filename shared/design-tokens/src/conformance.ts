/**
 * The contract's conformance test: does an app's token mapping actually clear
 * the contrast floors the contract promises?
 *
 * ## Why this is not the cire harness moved sideways
 *
 * `cire/host/tests/styles/tokens.test.ts` — the thing this generalises — finds
 * tokens with a regex over **literal** `--name: oklch(…)` declarations inside a
 * block located by exact string match. That works there because cire's ramps
 * *are* literals. A contract mapping never is: it is `--ui-ink: var(--text)`,
 * pointing at a token declared somewhere else in the file, possibly itself
 * pointing at a third. There is no literal to match, so the regex approach
 * finds nothing and silently asserts about an empty set — a test that cannot
 * fail. Hence the `var()` resolver below, which is the substance of this file.
 *
 * ## What it proves, and what it cannot
 *
 * It reads the stylesheet, not the browser. It therefore knows nothing about
 * the cascade beyond the scopes you name, cannot see a colour injected at
 * runtime (cire's per-wedding palette lands on `<html>` from the server), and
 * will not notice an element that sits on a ground the mapping never mentions.
 * It is a **drift guard**: every ratio here passed when the mapping was tuned,
 * and this stops a later nudge to one lightness quietly pushing secondary ink
 * under 4.5:1. Real rendering is the browser tier's job.
 *
 * ## Alpha
 *
 * Half the ink tokens in this monorepo are translucent, and a naive ratio
 * overstates every one of them. A translucent colour has no contrast ratio on
 * its own, so each is composited over the ground it is being measured against
 * first — in sRGB, because that is where a browser does it.
 */

import { contrastOklch, type Oklch, oklchToRgb, parseColor, rgbToOklch } from "@shared/color";

import { contrastPairs, WCAG_TEXT, WCAG_UI } from "./index";

/** One scope of the cascade to evaluate — a theme, essentially. */
export interface ConformanceScope {
  /**
   * What to call this scope when a failure is reported. Use the thing a reader
   * would recognise: `"dark"`, `"light"`, `"light (system preference)"`.
   */
  name: string;
  /**
   * Selectors whose declarations make up this scope, **in cascade order** —
   * later entries win. A dark-default app with an explicit light override is
   * `[":root", ":root[data-theme=\"light\"]"]`; the bare `:root` supplies
   * everything light does not override.
   */
  selectors: readonly string[];
}

export interface ConformanceOptions {
  /** The stylesheet's contents. Read it with `readFileSync` at the call site — this module does no I/O, so it runs anywhere. */
  css: string;
  /** The themes to check. An app with one theme passes one scope. */
  scopes: readonly ConformanceScope[];
  /**
   * Tokens this app is not asserted about, each with the reason why.
   *
   * Two different situations, deliberately sharing one escape hatch:
   *
   * - **Not mapped.** The app has no colour that plays this role.
   * - **Mapped, but below the floor.** The app has one and it does not clear
   *   WCAG — usually a defect that predates the contract. `@musubi/social`'s
   *   input boundary is 1.30:1 against its own page; the contract did not
   *   introduce that, it revealed it.
   *
   * Both are waivers, and both cost the same thing to use: a reason, in prose,
   * which is printed in the failure output of any pair that referenced the
   * token. "We never got round to it" therefore reads as exactly that in CI,
   * and a waiver carrying a tracker reference stays attached to the thing it
   * excuses rather than living in a comment someone deletes.
   *
   * What a waiver does NOT do is change what components render. A waived
   * `--ui-hairline-strong` still needs mapping, or every shared component
   * that draws a control boundary falls back to this package's neutral grey.
   */
  waived?: Readonly<Record<string, string>>;
}

export interface ConformanceFailure {
  scope: string;
  fg: string;
  bg: string;
  /** `null` when the pair could not be measured at all — see {@link ConformanceFailure.reason}. */
  ratio: number | null;
  required: number;
  reason: string;
}

/** Declarations of one block, keyed by custom-property name. */
type Declarations = Map<string, string>;

/**
 * Pull every custom-property declaration out of the blocks a selector list
 * names, merging them in the order given so a later scope overrides an earlier.
 *
 * Brace counting rather than a regex for the block body: `@media` and `@layer`
 * nest, and a lazy `\{([^}]*)\}` stops at the first inner `}` and silently
 * truncates the scope — which would look like a missing token rather than a
 * parse bug.
 */
function collect(css: string, selectors: readonly string[]): Declarations {
  const out: Declarations = new Map();

  for (const selector of selectors) {
    let from = 0;
    let found = false;

    // A selector can legitimately appear more than once (`:root` usually does);
    // every occurrence contributes, in source order.
    for (;;) {
      const at = css.indexOf(selector, from);
      if (at === -1) break;

      const open = css.indexOf("{", at + selector.length);
      if (open === -1) break;

      // Only a block whose selector ENDS here, or is followed by a comma or
      // whitespace before the brace — otherwise `:root` matches the `:root` of
      // `:root[data-theme="light"]` and merges the light scope into the dark one.
      const between = css.slice(at + selector.length, open).trim();
      if (between !== "" && between !== ",") {
        from = at + selector.length;
        continue;
      }

      let depth = 0;
      let end = -1;
      for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end === -1) throw new Error(`unbalanced braces after \`${selector}\``);

      for (const [, name, value] of css
        .slice(open + 1, end)
        .matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]?/g)) {
        out.set(name, value.trim());
      }

      found = true;
      from = end;
    }

    if (!found) throw new Error(`no block matches selector \`${selector}\``);
  }

  return out;
}

const VAR = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/;

/**
 * Follow a value through however many `var()` hops it takes to reach something
 * a colour parser recognises.
 *
 * A contract mapping is at least two hops (`--ui-ink` → `--text` → a literal)
 * and cire's ramps make it three. `seen` is not paranoia: `--a: var(--b)` with
 * `--b: var(--a)` is a stylesheet someone will eventually write, and without it
 * this recurses until the stack gives out and reports as a crash rather than as
 * the cycle it is.
 */
function resolve(value: string, decls: Declarations, seen: Set<string> = new Set()): string | null {
  const trimmed = value.trim();
  const match = VAR.exec(trimmed);
  if (!match) return trimmed;

  const [, name, fallback] = match;
  if (seen.has(name)) return null;
  seen.add(name);

  const next = decls.get(name);
  if (next !== undefined) return resolve(next, decls, seen);
  return fallback === undefined ? null : resolve(fallback, decls, seen);
}

/**
 * Composite a translucent colour over an opaque ground, in sRGB.
 *
 * sRGB rather than OKLCH because that is what a browser does — alpha
 * compositing happens in the device space, after conversion.
 */
function over(fg: Oklch, bg: Oklch): Oklch {
  const f = oklchToRgb(fg);
  const b = oklchToRgb(bg);
  const a = fg.a ?? 1;
  return rgbToOklch({
    r: a * f.r + (1 - a) * b.r,
    g: a * f.g + (1 - a) * b.g,
    b: a * f.b + (1 - a) * b.b,
  });
}

/**
 * Measure every contrast pair the contract defines, in every scope, and return
 * what failed.
 *
 * Returns rather than throws so a caller can assert on the whole list at once:
 * one failing test naming six bad pairs is a fix, six failing tests naming one
 * each is an afternoon.
 */
export function checkContractConformance(options: ConformanceOptions): ConformanceFailure[] {
  const { css, scopes, waived = {} } = options;
  const failures: ConformanceFailure[] = [];

  for (const scope of scopes) {
    const decls = collect(css, scope.selectors);

    for (const { fg, bg, min } of contrastPairs()) {
      const skip = waived[fg] ?? waived[bg];
      if (skip !== undefined) continue;

      const fgRaw = decls.get(fg);
      const bgRaw = decls.get(bg);

      for (const [token, raw] of [
        [fg, fgRaw],
        [bg, bgRaw],
      ] as const) {
        if (raw === undefined) {
          failures.push({
            scope: scope.name,
            fg,
            bg,
            ratio: null,
            required: min,
            reason: `\`${token}\` is not mapped in this scope. Map it, or declare it in \`waived\` with a reason.`,
          });
        }
      }
      if (fgRaw === undefined || bgRaw === undefined) continue;

      const fgResolved = resolve(fgRaw, decls);
      const bgResolved = resolve(bgRaw, decls);
      if (fgResolved === null || bgResolved === null) {
        failures.push({
          scope: scope.name,
          fg,
          bg,
          ratio: null,
          required: min,
          reason: `a \`var()\` chain from \`${fgResolved === null ? fg : bg}\` does not terminate in a colour — either it is cyclic, or it points at a token this scope never declares.`,
        });
        continue;
      }

      const fgColor = parseColor(fgResolved);
      const bgColor = parseColor(bgResolved);
      if (!fgColor || !bgColor) {
        failures.push({
          scope: scope.name,
          fg,
          bg,
          ratio: null,
          required: min,
          reason: `unparseable colour: \`${!fgColor ? `${fg} → ${fgResolved}` : `${bg} → ${bgResolved}`}\``,
        });
        continue;
      }

      // A translucent GROUND has nothing to composite over — it is the bottom
      // of the stack as far as this check can see, so measuring against it
      // would be measuring against a colour that never actually appears.
      if ((bgColor.a ?? 1) < 1) {
        failures.push({
          scope: scope.name,
          fg,
          bg,
          ratio: null,
          required: min,
          reason: `\`${bg}\` is translucent. A ground must be opaque: what sits behind it is not knowable from the stylesheet.`,
        });
        continue;
      }

      const composited = (fgColor.a ?? 1) < 1 ? over(fgColor, bgColor) : fgColor;
      const ratio = contrastOklch(composited, bgColor);

      if (ratio < min) {
        failures.push({
          scope: scope.name,
          fg,
          bg,
          ratio,
          required: min,
          reason:
            (fgColor.a ?? 1) < 1
              ? `${ratio.toFixed(2)}:1 after compositing over \`${bg}\`, needs ${min}:1`
              : `${ratio.toFixed(2)}:1, needs ${min}:1`,
        });
      }
    }
  }

  return failures;
}

/**
 * {@link checkContractConformance}, as an assertion.
 *
 * The thrown message lists every failure with its scope, its measured ratio and
 * what it needed, because the alternative — a bare "expected true to be false"
 * — sends the reader back to the stylesheet with no idea which of forty pairs
 * moved.
 */
export function assertContractConformance(options: ConformanceOptions): void {
  const failures = checkContractConformance(options);
  if (failures.length === 0) return;

  const lines = failures.map((f) => `  [${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`);
  throw new Error(
    `${failures.length} contract conformance failure(s):\n${lines.join("\n")}\n\n` +
      `Floors: body text ${WCAG_TEXT}:1, large text and non-text UI ${WCAG_UI}:1.`,
  );
}
