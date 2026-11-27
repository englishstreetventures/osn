import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SERVICES_DIR = join(import.meta.dirname, "../../src/services");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A file's text with its block and line comments removed. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * A source guard, not a behaviour test. On Bun a bare `Effect.forkDetach` is
 * neither interrupted nor awaited and the mail still sends, so a service test
 * that reads the recorded notice passes whether or not the work would survive
 * on workerd. Only `tests/d1/waituntil.test.ts` sees the difference, and only
 * for the path it drives. This check covers every other site: a detached send
 * anywhere under `src/services/` fails here, and the failure names the fix.
 */
describe("background work dispatch", () => {
  it("dispatches every service-side detached send through the request's sink", () => {
    const offenders = tsFilesUnder(SERVICES_DIR)
      // Any use in code: `Effect.forkDetach(…)`, `.pipe(Effect.forkDetach)`,
      // a type-argument call or a destructured `forkDetach`.
      .filter((file) => /\bforkDetach\b/.test(codeOf(file)))
      .map((file) => file.slice(SERVICES_DIR.length + 1));

    // If this fails: use `forkBackground` from `src/lib/background.ts` instead
    // of a bare `Effect.forkDetach`. On workerd a promise not handed to
    // `ExecutionContext.waitUntil` may never run, so a detached send can be
    // dropped after the response returns — invisibly, because it still
    // completes on the Bun dev server.
    expect(offenders).toEqual([]);
  });

  it("routes all twenty-seven known background sites through forkBackground", () => {
    // Counted rather than merely asserted absent, so deleting a send is as
    // loud as converting one back.
    const total = tsFilesUnder(SERVICES_DIR)
      .map((file) => readFileSync(file, "utf8").split("yield* forkBackground(").length - 1)
      .reduce((sum, n) => sum + n, 0);

    // Nine notification sends, eight link sends (sign-up, recovery, step-up
    // and email change, each at begin and on a Resend), the three lockout audit
    // rows (recovery code, emailed recovery link, step-up link), the two lockout resets after a success (recovery code, TOTP), the
    // pending sign-up's delete after a completing poll, the three deletes of
    // a decided or expired cross-device request, and the delete of a
    // completed email change's pending entry.
    expect(total).toBe(27);
  });
});
