import type { Card } from "../../pr-metrics/index.ts";

/**
 * Every card under `.claude/metrics/`, read at build time.
 *
 * The glob is literal on purpose — Vite resolves `import.meta.glob` when it
 * bundles and cannot see through a variable. `import: "default"` unwraps the
 * JSON module so each value is the card itself. The path climbs from
 * `tools/metrics/src` to the repo root; `vite.config.ts` allow-lists that root,
 * which is what lets the dev server serve files outside the package.
 */
const modules = import.meta.glob<Card>("../../../.claude/metrics/*.json", {
  eager: true,
  import: "default",
});

export const cards: Card[] = Object.entries(modules)
  .toSorted(([a], [b]) => a.localeCompare(b))
  .map(([, card]) => card);
