/**
 * What one evaluation of the probe stack may do, decided before it reads
 * anything else.
 *
 * Alchemy evaluates the stack body for `plan`, `deploy` and `destroy` alike
 * and tells it none of them apart, so teardown is asked for explicitly with
 * `ALCHEMY_PROBE_TEARDOWN=1` (the package's `destroy` script sets it). A
 * teardown run declares nothing: `destroy` removes what state holds, and a
 * `deploy` in teardown mode does the same — the probe Workers are deleted
 * and the retained storage is forgotten, never deleted — so the flag cannot
 * be used to deploy without the checks.
 */
export type RunMode =
  | { readonly kind: "deploy" }
  | { readonly kind: "teardown" }
  | { readonly kind: "refuse"; readonly reason: string };

export function runMode(input: {
  readonly stage: string;
  /** The process's working directory, resolved through symlinks. */
  readonly cwd: string;
  /** The directory holding `alchemy.run.ts`, resolved through symlinks. */
  readonly stackDir: string;
  readonly teardown: boolean;
}): RunMode {
  if (input.stage !== "dev") {
    return {
      kind: "refuse",
      reason: `The Alchemy probe only runs at stage dev, not '${input.stage}'.`,
    };
  }
  // Local state lives in `.alchemy/` under the directory the CLI starts in;
  // a run from anywhere else would plan against empty state.
  if (input.cwd !== input.stackDir) {
    return {
      kind: "refuse",
      reason: `Run the Alchemy probe from ${input.stackDir} (its package scripts do), not ${input.cwd}.`,
    };
  }
  return input.teardown ? { kind: "teardown" } : { kind: "deploy" };
}
