#!/usr/bin/env bun
/**
 * Rewrite arbitrary Tailwind type values onto the contract's scales.
 *
 * The monorepo carries 1,062 bracketed `text-[…]`, `tracking-[…]` and
 * `leading-[…]` values across 93 distinct font sizes, which is not a house
 * style — it is drift. `@shared/design-tokens` publishes seven type steps and
 * a closed old→new table (`SCALE_MIGRATION`); this applies it.
 *
 * ## Why a script rather than an afternoon of editing
 *
 * A thousand hand-edits is unreviewable, and a reviewer reading that diff has
 * no way to check anything except the sites themselves. With a transform, the
 * thing to review is the **table** — which lives in `@shared/design-tokens`
 * because the mapping is the decision and this file is only the thing that
 * carries it out — plus the report below, which says what was left alone.
 *
 * ## What it must never touch, and how it avoids each
 *
 * **Computed values.** `text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]`
 * is not a size; it is an expression whose value depends on a custom property
 * an organiser sets. Snapping it to a step deletes a feature people pay for.
 * These are skipped by looking for `var(`, `calc(`, `clamp(`, `min(`, `max(`
 * and `gradient` in the bracket body — and reported, so "37 computed values
 * skipped" is visible rather than the difference between 1,062 and 1,025 being
 * something a reviewer has to notice.
 *
 * **Variants.** `data-[state=open]:`, `aria-[invalid=true]:` and
 * `supports-[…]:` share the bracket syntax and are selectors, not values. The
 * pattern below therefore requires the utility name to be one of exactly three
 * — `text`, `tracking`, `leading` — and the bracket to be followed by a word
 * boundary rather than a `:`. A transform that treated a variant as a value
 * would corrupt behaviour rather than appearance, which is worse and much
 * harder to spot.
 *
 * **Values the table has no entry for.** Left alone and counted. An unmapped
 * value is a gap in the table, which is a decision for whoever owns the scale
 * — not something a script should round. The four in the tree today are `em`
 * units (`text-[1em]`), which are relative to the parent's size and so are a
 * genuinely different thing from the `rem` steps the scale is written in.
 *
 * ## It is idempotent
 *
 * A second run over its own output produces no diff, because the output has no
 * brackets left for the pattern to match. `scripts/tests/` asserts that
 * directly rather than leaving it as a claim.
 *
 * Usage:
 *   bun run scripts/codemod-scale.ts <path>...        # rewrite in place
 *   bun run scripts/codemod-scale.ts --dry <path>...  # report only
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A relative import, not `@shared/design-tokens`: `scripts/` is not a
// workspace, so the root has no `node_modules` entry to resolve the bare
// specifier through. The table still lives in the package — this file reaches
// into it rather than keeping a copy, which is the whole point.
import { SCALE_MIGRATION } from "../shared/design-tokens/src/index";

/**
 * The three utilities the contract publishes a scale for.
 *
 * Spacing, sizing and radius brackets are deliberately absent: Tailwind's own
 * spacing scale already covers `px-3`, and the contract does not redefine it.
 * Adding one here without a `SCALE_MIGRATION` entry would be a no-op; adding
 * one *with* a hand-written table would put the decision in the wrong file.
 */
const SCALES = ["text", "tracking", "leading"] as const;
type Scale = (typeof SCALES)[number];

/** A bracket body that is an expression, not a value. */
const COMPUTED = /var\(|calc\(|clamp\(|min\(|max\(|gradient/;

/**
 * A lookbehind for "not part of a longer identifier", which is the only thing
 * the boundary has to do.
 *
 * Variant protection is not a boundary problem and is not solved here: it is
 * solved by the utility name having to be one of exactly three. No Tailwind
 * variant is called `text`, `tracking` or `leading`, so `data-[state=open]`,
 * `aria-[invalid=true]` and `supports-[display:grid]` can never match — while
 * the *value* in `data-[state=open]:text-[0.9rem]` still does, which is right,
 * because that half is a size.
 *
 * `(?<![\w-])` and not `(^|[\s"'`])`: the character before a utility is very
 * often a `:` from its own variant (`md:text-[0.9rem]`), and requiring
 * whitespace silently skipped every one of those — without even listing them
 * in the skip report, which is the worst of both.
 */
const ARBITRARY = new RegExp(String.raw`(?<![\w-])(${SCALES.join("|")})-\[([^\]]+)\]`, "g");

export interface Rewrite {
  readonly from: string;
  readonly to: string;
}

export interface SkippedValue {
  readonly value: string;
  readonly why: "computed" | "unmapped";
}

export interface FileResult {
  readonly source: string;
  readonly rewrites: readonly Rewrite[];
  readonly skipped: readonly SkippedValue[];
}

/** Apply the table to one file's contents. Pure — the CLI below does the I/O. */
export function rewriteScales(source: string): FileResult {
  const rewrites: Rewrite[] = [];
  const skipped: SkippedValue[] = [];

  const out = source.replace(ARBITRARY, (whole, scale: string, value: string) => {
    const original = `${scale}-[${value}]`;
    if (COMPUTED.test(value)) {
      skipped.push({ value: original, why: "computed" });
      return whole;
    }
    const step = SCALE_MIGRATION[scale as Scale][value as never] as string | undefined;
    if (!step) {
      skipped.push({ value: original, why: "unmapped" });
      return whole;
    }
    const replacement = `${scale}-ui-${step}`;
    rewrites.push({ from: original, to: replacement });
    return replacement;
  });

  return { source: out, rewrites, skipped };
}

/** Every `.tsx` and `.astro` under a path, or the path itself if it is one. */
function targets(path: string): string[] {
  const stat = statSync(path);
  if (!stat.isDirectory()) return /\.(tsx|astro)$/.test(path) ? [path] : [];
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    out.push(...targets(join(path, entry)));
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const paths = argv.filter((a) => a !== "--dry");

  if (paths.length === 0) {
    console.error("usage: codemod-scale.ts [--dry] <path>...");
    process.exit(2);
  }

  let changed = 0;
  let rewritten = 0;
  const skipTally = new Map<string, { count: number; why: string }>();

  for (const path of paths) {
    for (const file of targets(path)) {
      const before = readFileSync(file, "utf8");
      const result = rewriteScales(before);
      for (const s of result.skipped) {
        const seen = skipTally.get(s.value) ?? { count: 0, why: s.why };
        skipTally.set(s.value, { count: seen.count + 1, why: s.why });
      }
      if (result.source === before) continue;
      changed++;
      rewritten += result.rewrites.length;
      if (!dry) writeFileSync(file, result.source);
      console.log(`${dry ? "would rewrite" : "rewrote"} ${file} — ${result.rewrites.length}`);
    }
  }

  console.log(`\n${rewritten} value(s) across ${changed} file(s)`);

  // The skip report is the point of the exercise, not a footnote: a reviewer
  // has to be able to see that the computed values were LOOKED AT and left,
  // rather than missed.
  if (skipTally.size > 0) {
    const computed = [...skipTally].filter(([, v]) => v.why === "computed");
    const unmapped = [...skipTally].filter(([, v]) => v.why === "unmapped");
    const total = (xs: typeof computed) => xs.reduce((n, [, v]) => n + v.count, 0);
    console.log(`\nleft alone — ${total(computed)} computed, ${total(unmapped)} unmapped:`);
    for (const [value, { count, why }] of [...computed, ...unmapped]) {
      console.log(`  ${why.padEnd(8)} ${value}${count > 1 ? ` ×${count}` : ""}`);
    }
  }
}
