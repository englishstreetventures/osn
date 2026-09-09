/**
 * Number formatting shared by the `<details>` renderer and the dashboard.
 *
 * This file imports nothing, and that is its contract rather than an accident
 * of how small it is. `index.ts` is the CLI: it reads `node:fs` at module scope,
 * which Vite replaces with a stub that throws on first property access, so a
 * browser module that imports anything from it dies during evaluation — before
 * it renders, and with an empty page as the only symptom. `@tools/metrics` is a
 * browser app and needs these two functions, so they live where it can reach
 * them. `report.ts` is import-free for the same reason.
 *
 * `tools/metrics/tests/browser-safe.test.ts` asserts the no-imports property.
 */

/** 66_000_000 → "66.0M". Cards run to tens of millions of tokens and a raw
 * digit string at that size is unreadable in a table. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;

  return String(value);
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  const hours = Math.floor(seconds / 3600);

  return `${hours}h ${Math.round((seconds % 3600) / 60)}m`;
}
