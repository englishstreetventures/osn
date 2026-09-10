import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SERVICES_DIR = join(import.meta.dirname, "../../src/services");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * A source guard, not a behaviour test — deliberately.
 *
 * The defect this branch fixes is invisible at every tier that can run here:
 * on Bun a bare `Effect.forkDetach` is neither interrupted nor awaited and the
 * mail sends, so a service test asserting "the notice was recorded" passes
 * whether or not the work would survive on workerd. Only
 * `tests/d1/waituntil.test.ts` can see the difference, and it can only see it
 * for the one path it drives.
 *
 * So what protects the other six sites is this: a new detached send anywhere
 * under `src/services/` fails here, and the failure names the fix. That is the
 * regression a future contributor would otherwise introduce silently, having
 * copied the shape from a sibling.
 */
describe("background work dispatch", () => {
  it("dispatches every service-side detached send through the request's sink", () => {
    const offenders = tsFilesUnder(SERVICES_DIR)
      .filter((file) => readFileSync(file, "utf8").includes("Effect.forkDetach("))
      .map((file) => file.slice(SERVICES_DIR.length + 1));

    // If this fails: use `forkBackground` from `src/lib/background.ts` instead
    // of a bare `Effect.forkDetach`. On workerd a promise not handed to
    // `ExecutionContext.waitUntil` may never run, so a detached send can be
    // dropped after the response returns — invisibly, because it still
    // completes on the Bun dev server.
    expect(offenders).toEqual([]);
  });

  it("routes all ten known notification sites through forkBackground", () => {
    // Counted rather than merely asserted absent, so deleting a send is as
    // loud as converting one back.
    const total = tsFilesUnder(SERVICES_DIR)
      .map((file) => readFileSync(file, "utf8").split("yield* forkBackground(").length - 1)
      .reduce((sum, n) => sum + n, 0);

    expect(total).toBe(10);
  });
});
