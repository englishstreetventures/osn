/**
 * How far into the day-of run sheet a helper sees, and how the portal words it.
 *
 * It mirrors `RunSheetScope` in `cire/api/src/services/hosts.ts`: `own` is the
 * tasks assigned to the helper, `full` is every task and who holds it. It is a
 * helper's setting alone — an owner, editor or viewer sees the whole run sheet
 * whatever their seat stores — so the co-host panel shows it on helper rows and
 * nowhere else. The API is the enforcement: it narrows the run sheet itself, and
 * only an owner may set this.
 */

export type RunSheetScope = "own" | "full";

/** How the portal words each scope. */
interface RunSheetScopeCopy {
  /** The option in an owner's dropdown. */
  option: string;
  /** What the helper sees, finishing "Sees: …" and "@bob now sees …". */
  phrase: string;
}

/** Keyed by every scope, so a scope added here has to be worded before this
 *  compiles. The order is the dropdown's: narrowest first. */
export const RUN_SHEET_SCOPE_COPY = {
  own: { option: "Their own tasks", phrase: "their own tasks" },
  full: { option: "The whole run sheet", phrase: "the whole run sheet" },
} satisfies Record<RunSheetScope, RunSheetScopeCopy>;

export const RUN_SHEET_SCOPES = Object.keys(RUN_SHEET_SCOPE_COPY) as RunSheetScope[];

/**
 * Read a scope off an API body, or `fallback` when it holds none the portal
 * knows. `Object.hasOwn`, never `in`, so `constructor` is not a scope.
 */
export function readRunSheetScope(value: unknown, fallback: RunSheetScope): RunSheetScope {
  return typeof value === "string" && Object.hasOwn(RUN_SHEET_SCOPE_COPY, value)
    ? (value as RunSheetScope)
    : fallback;
}
