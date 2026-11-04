// `bun run plan:guard` as the production release runs it in cire/infra: the
// stack's entry, the `--` before its arguments, and its exit code, over a
// production plan in the shape `deploy --dry-run` logs it and over a real dev
// deploy log (shared/infra/tests/fixtures), which the production guard refuses.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DEV_LOG = fileURLToPath(
  new URL("../../../shared/infra/tests/fixtures/alchemy-dev-cire.log", import.meta.url),
);

/** The production plan step's log: Alchemy's records, the plan lines last. */
const PRODUCTION_LOG = [
  "$ CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage production --dry-run",
  "[20:17:41.001] INFO (#1): Deploy · production",
  "[20:17:44.120] INFO (#1): Computing plan",
  "[20:17:45.300] INFO (#1): Plan ready (4.2s)",
  "[20:17:45.301] INFO (#1): Plan: 1 to update",
  "[20:17:45.301] INFO (#1): [CireHost] update",
  "[20:17:45.301] INFO (#1): [CireLanding] noop",
  "[20:17:45.301] INFO (#1): [CireVendor] noop",
  "",
].join("\n");

/**
 * The hosts each site's Worker holds now, as the domains step reads them:
 * each at the host its mode declares, so no domain changes.
 */
const LIVE_DOMAINS = {
  cire_host: ["next.host.cireweddings.com"],
  cire_vendor: ["next.vendor.cireweddings.com"],
  cire_landing: ["next.cireweddings.com"],
};

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
      flip: null,
      domains: [],
      unflip: null,
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

  test("G17: allows the move off the retired spare hosts with no flip or unflip, recording both; a Worker giving up another site's refuses", () => {
    const swapLog = [
      "[20:17:45.301] INFO (#1): Plan: 2 to update",
      "[20:17:45.301] INFO (#1): [CireHost] update",
      "[20:17:45.301] INFO (#1): [CireLanding] noop",
      "[20:17:45.301] INFO (#1): [CireVendor] update",
      "",
    ].join("\n");
    const retired = {
      ...LIVE_DOMAINS,
      cire_host: ["next-host.cireweddings.com"],
      cire_vendor: ["next-vendor.cireweddings.com"],
    };
    const swap = guard(swapLog, retired);
    expect(swap.stdout).not.toContain("::error::");
    expect(swap.exitCode).toBe(0);
    expect(swap.record).toEqual({
      stack: "cire",
      plan: "changes",
      counts: { update: 2 },
      resources: [
        { fqn: "CireHost", kind: "custom-domain", action: "update" },
        { fqn: "CireLanding", kind: "custom-domain", action: "noop" },
        { fqn: "CireVendor", kind: "custom-domain", action: "update" },
      ],
      bindings: [],
      flip: null,
      domains: [
        {
          site: "cire_host",
          added: ["next.host.cireweddings.com"],
          removed: ["next-host.cireweddings.com"],
        },
        {
          site: "cire_vendor",
          added: ["next.vendor.cireweddings.com"],
          removed: ["next-vendor.cireweddings.com"],
        },
      ],
      unflip: null,
    });
    const crossed = guard(swapLog, { ...retired, cire_host: ["next-vendor.cireweddings.com"] });
    expect(crossed.exitCode).toBe(1);
    expect(crossed.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      "::error::cire production plan refused: cire_host's Worker would give up next-vendor.cireweddings.com; only a release dispatched with unflip: cire_host takes a production host off its Worker",
    ]);
  }, 30_000);
});
