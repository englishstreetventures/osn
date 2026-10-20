import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Flows wait on what the page shows or the network returns, never on time: a
// fixed sleep is a flake on a slow runner and dead time on a fast one, and
// `networkidle` never settles on a dev server holding an HMR socket open.
const FORBIDDEN = [/waitForTimeout\(/, /\bsetTimeout\(/, /networkidle/, /\.only\(/];

const dirs = [join(import.meta.dirname, "flows"), join(import.meta.dirname, "support")];

describe("flow sources", () => {
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      test(`${file} waits on state, not time`, () => {
        const source = readFileSync(join(dir, file), "utf8");
        for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern);
      });
    }
  }

  test("every flow file is named *.flow.ts, the only files Playwright collects", () => {
    const files = readdirSync(join(import.meta.dirname, "flows"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toEndWith(".flow.ts");
  });

  // cire-api allows 5 claims a minute per IP (`defaultClaimLimiter` in
  // cire/api/src/app.ts), one window shared by the whole run. A sixth claim
  // gets 429 only when it lands inside the first one's minute, which depends
  // on how fast the machine is: a run that passes locally and fails in CI, in
  // a flow nobody touched. Counted here, so the commit that adds it goes red.
  test("the flows claim no more invitation codes than cire-api allows in a minute", () => {
    const dir = join(import.meta.dirname, "flows");
    const claims = readdirSync(dir)
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .map((source) => source.match(/name: "Open Invitation" \}\)\.click\(/g)?.length ?? 0)
      .reduce((sum, n) => sum + n, 0);
    expect(claims).toBeGreaterThan(0);
    expect(claims).toBeLessThanOrEqual(5);
  });
});
