// `bun run plan:guard` as the production release runs it in cire/infra: the
// stack's entry, the `--` before its arguments, and its exit code, over a
// production plan in the shape `deploy --dry-run` logs it and over a real dev
// deploy log (shared/infra/tests/fixtures), which the production guard refuses.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { PRODUCTION_SITE_DOMAINS } from "../src/declaration";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DEV_LOG = fileURLToPath(
  new URL("../../../shared/infra/tests/fixtures/alchemy-dev-cire.log", import.meta.url),
);

/** The production plan step's log: Alchemy's records, the plan lines last. */
const PRODUCTION_LOG = [
  "$ CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage production --dry-run",
  "[20:17:41.001] INFO: Plan · production",
  "[20:17:44.120] INFO: Computing plan",
  "[20:17:45.300] INFO: Plan ready (4.2s)",
  "[20:17:45.301] INFO: Plan: 1 to update",
  "[20:17:45.301] INFO: [CireHost] update",
  "[20:17:45.301] INFO: [CireLanding] noop",
  "[20:17:45.301] INFO: [CireVendor] noop",
  "",
].join("\n");

/**
 * The hosts each site's Worker holds now, as the domains step reads them:
 * each the host the declaration gives it, so no domain changes, whatever
 * PRODUCTION_HOST_HOLDS holds.
 */
const LIVE_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(PRODUCTION_SITE_DOMAINS).map(([site, host]) => [
    site,
    host === null || host === undefined ? [] : [host],
  ]),
);

/**
 * Runs the entry over `log` as the workflow's guard step does, with no step
 * summary file, the site Workers holding `live`.
 */
function guard(log: string, live: unknown = LIVE_DOMAINS) {
  const dir = mkdtempSync(join(tmpdir(), "cire-plan-guard-"));
  try {
    const logFile = join(dir, "cire.log");
    const out = join(dir, "plan-guard", "cire.json");
    const domains = join(dir, "domains.json");
    writeFileSync(logFile, log);
    writeFileSync(domains, JSON.stringify(live));
    const result = Bun.spawnSync(
      ["bun", "run", "plan:guard", "--", "--log", logFile, "--out", out, "--domains", domains],
      { cwd: PACKAGE, env: { PATH: process.env.PATH } },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      record: JSON.parse(readFileSync(out, "utf8")) as unknown,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("plan:guard, the cire stack's production plan guard", () => {
  test("G16: allows a plan of the cire sites alone, exiting 0 and keeping its record", () => {
    const result = guard(PRODUCTION_LOG);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The guard allows this plan.");
    expect(result.stdout).not.toContain("::error::");
    expect(result.record).toEqual({
      stack: "cire",
      plan: "changes",
      counts: { update: 1 },
      resources: [
        { fqn: "CireHost", kind: "custom-domain", action: "update" },
        { fqn: "CireLanding", kind: "custom-domain", action: "noop" },
        { fqn: "CireVendor", kind: "custom-domain", action: "noop" },
      ],
      bindings: [],
      domains: [],
    });
  }, 30_000);

  test("G16: refuses a real dev plan, exiting 1 and naming every resource production does not declare", () => {
    const result = guard(readFileSync(DEV_LOG, "utf8"));
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual(
      ["CireApi", "CireAssets", "CireDb", "CireInvites", "CireSheets"].map(
        (fqn) =>
          `::error::cire production plan refused: ${fqn} is not a resource this stack declares on production`,
      ),
    );
    expect(result.record).toMatchObject({ stack: "cire", plan: "changes", counts: { update: 2 } });
  }, 30_000);

  test("G18: refuses the landing site's Worker giving up a host it holds beside its own", () => {
    const result = guard(PRODUCTION_LOG, {
      ...LIVE_DOMAINS,
      cire_landing: [...(LIVE_DOMAINS.cire_landing ?? []), "old.cireweddings.com"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      "::error::cire production plan refused: cire_landing's Worker would give up old.cireweddings.com; no release takes a production host off its Worker: remove it in the Cloudflare dashboard first",
    ]);
  }, 30_000);
});
