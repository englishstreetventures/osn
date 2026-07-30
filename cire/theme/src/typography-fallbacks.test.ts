import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TYPOGRAPHY_FALLBACKS, TYPOGRAPHY_VAR_NAMES, type TypographyKey } from "./index";

/**
 * Lockstep guard for the typography FALLBACKS — what each option looks like
 * when the organiser has not set it, i.e. the design pack's own base look.
 *
 * `typographyVars` has always been the one place a SET option resolves to a
 * value. The un-set state was the opposite: a literal repeated at every
 * consumer (`var(--invite-heading-weight, 300)`), 30-odd references across the
 * two guest packs, the guest `global.css` and the organiser previews, with
 * nothing checking they agreed. A pack that changed its base weight would have
 * left every organiser preview quietly misrepresenting "Default" — the same
 * bug as a preview that ignores the variable outright, one level down (T-S3).
 *
 * Consumers that build declarations at runtime now import `typographyVar` and
 * hold no literal. The guest packs cannot: their declarations are Tailwind
 * arbitrary-property classes, and Tailwind emits CSS by scanning source TEXT,
 * so an interpolated class name produces no rule at all. Those references are
 * necessarily literal — this test is what holds them to the canonical values.
 *
 * It reads sibling packages from disk on purpose. That is unusual for a
 * zero-dep package, and it is the point: `@cire/theme` owns these values, so
 * the assertion belongs next to them rather than duplicated into each consumer
 * (where a consumer could simply forget to add it).
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Source trees that consume the typography variables. */
const SCANNED = [
  "cire/web/src/designs",
  "cire/web/src/styles/global.css",
  "cire/organiser/src/components",
] as const;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".css", ".astro"];

function filesUnder(relative: string): string[] {
  const absolute = `${REPO_ROOT}${relative}`;
  const stat = statSync(absolute); // throws if a scanned path moved — deliberate
  if (stat.isFile()) return [absolute];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((e) => entry.name.endsWith(e)))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

interface VarReference {
  file: string;
  key: TypographyKey;
  /** The fallback as written, or null when the reference has none at all. */
  fallback: string | null;
}

/**
 * Every `var(--invite-…)` reference to a typography variable in the scanned
 * trees. Matches with and WITHOUT a fallback, so a bare `var(--x)` is caught
 * rather than skipped — that one renders as an invalid declaration when the
 * organiser leaves the option unset, which is a worse failure than drift.
 */
function typographyReferences(): VarReference[] {
  const byVarName = new Map<string, TypographyKey>(
    Object.entries(TYPOGRAPHY_VAR_NAMES).map(([key, name]) => [name, key as TypographyKey]),
  );
  const pattern = /var\(\s*(--invite-(?:heading|body)-[a-z-]+?)\s*(?:,\s*([^)]*?)\s*)?\)/g;
  const refs: VarReference[] = [];

  for (const relative of SCANNED) {
    for (const file of filesUnder(relative)) {
      // Test files quote these strings as expectations of the source they
      // assert; scanning them would make a wrong pack value agree with itself.
      if (file.includes(".test.")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const key = byVarName.get(match[1]!);
        if (!key) continue; // a non-typography --invite-* var (palette, scrim, …)
        refs.push({
          file: file.slice(REPO_ROOT.length),
          key,
          fallback: match[2] === undefined ? null : match[2],
        });
      }
    }
  }
  return refs;
}

describe("typography fallbacks stay in lockstep across packages", () => {
  const refs = typographyReferences();

  test("the scan actually finds the consumers", () => {
    // Guards the failure mode every source-scanning test has: a moved file or
    // a broken pattern turns the suite green by asserting nothing. The guest
    // packs alone carry three references on each of ~11 heading elements.
    expect(refs.length).toBeGreaterThanOrEqual(30);
    const files = new Set(refs.map((r) => r.file));
    expect([...files].some((f) => f.startsWith("cire/web/src/designs/classic/"))).toBe(true);
    expect([...files].some((f) => f.startsWith("cire/web/src/designs/gala/"))).toBe(true);
    expect([...files].some((f) => f.startsWith("cire/organiser/"))).toBe(true);
    expect(files).toContain("cire/web/src/styles/global.css");
  });

  test("every key is exercised somewhere", () => {
    // If a consumer stops referencing a variable entirely, the option silently
    // stops doing anything — the original bug, and invisible to the checks
    // below (which only judge the references that exist).
    for (const key of Object.keys(TYPOGRAPHY_FALLBACKS) as TypographyKey[]) {
      expect(refs.some((r) => r.key === key)).toBe(true);
    }
  });

  test("no reference omits its fallback", () => {
    // A bare `var(--invite-heading-weight)` is invalid at computed-value time
    // while the option is unset, so the heading would render at the CSS
    // initial weight (400) instead of the pack's 300.
    const bare = refs.filter((r) => r.fallback === null);
    expect(bare.map((r) => `${r.file}: var(${TYPOGRAPHY_VAR_NAMES[r.key]})`)).toEqual([]);
  });

  test("every fallback matches the canonical value in @cire/theme", () => {
    const wrong = refs
      .filter((r) => r.fallback !== TYPOGRAPHY_FALLBACKS[r.key])
      .map(
        (r) =>
          `${r.file}: var(${TYPOGRAPHY_VAR_NAMES[r.key]}, ${r.fallback}) — expected ${TYPOGRAPHY_FALLBACKS[r.key]}`,
      );
    expect(wrong).toEqual([]);
  });
});
