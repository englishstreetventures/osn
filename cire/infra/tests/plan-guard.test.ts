// `bun run plan:guard` as the production release runs it in cire/infra: the
// stack's entry, the `--` before its arguments, and its exit code, over a
// production plan in the shape `deploy --dry-run` logs it and over a real dev
// deploy log (shared/infra/tests/fixtures), which the production guard refuses.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { LedgerCounts, LiveState } from "../../../shared/infra/src/production-live";
import { CONVERTED_LEDGER, matchingLive } from "../../../shared/infra/tests/support/live-state";
import { PRODUCTION_ADOPTED, PRODUCTION_DOMAINS } from "../src/declaration";

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
  Object.entries(PRODUCTION_DOMAINS).map(([surface, host]) => [
    surface,
    host === null || host === undefined ? [] : [host],
  ]),
);

/** The live read of the stack's adopted resources, each as its declaration states it. */
const LIVE_STATE: LiveState = matchingLive(PRODUCTION_ADOPTED);

/**
 * Runs the entry over `log` as the workflow's guard step does, with no step
 * summary file, the site Workers holding `live`.
 */
function guard(log: string, live: unknown = LIVE_DOMAINS, state: LiveState = LIVE_STATE) {
  const dir = mkdtempSync(join(tmpdir(), "cire-plan-guard-"));
  try {
    const logFile = join(dir, "cire.log");
    const out = join(dir, "plan-guard", "cire.json");
    const domains = join(dir, "domains.json");
    const liveFile = join(dir, "live.json");
    writeFileSync(logFile, log);
    writeFileSync(domains, JSON.stringify(live));
    writeFileSync(liveFile, JSON.stringify(state));
    const result = Bun.spawnSync(
      [
        "bun",
        "run",
        "plan:guard",
        "--",
        "--log",
        logFile,
        "--out",
        out,
        "--domains",
        domains,
        "--live",
        liveFile,
      ],
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

/** The first release that adopts cire's API Workers and storage, as `deploy --dry-run` logs it. */
const ADOPTION_LOG = [
  "[20:17:45.301] INFO: Plan: 1 to create, 4 to adopted, 1 binding changes",
  "[20:17:45.301] INFO: [CireApi] create",
  "[20:17:45.301] INFO: [CireApi/REALTIME_HUB] create",
  "[20:17:45.301] INFO: [CireAssets] adopted",
  "[20:17:45.301] INFO: [CireDb] adopted",
  "[20:17:45.301] INFO: [CireHost] noop",
  "[20:17:45.301] INFO: [CireInvites] adopted",
  "[20:17:45.301] INFO: [CireLanding] noop",
  "[20:17:45.301] INFO: [CireSheets] adopted",
  "[20:17:45.301] INFO: [CireVendor] noop",
  "",
].join("\n");

const errors = (stdout: string) =>
  stdout.split("\n").filter((line) => line.startsWith("::error::"));

describe("plan:guard, the cire stack's production plan guard", () => {
  test("G16: allows a plan that updates a site, exiting 0 and keeping its record", () => {
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

  test("GP1: allows the first adoption, cire-api's create adopted at deploy since it exists live, and lists what the live read found", () => {
    const result = guard(ADOPTION_LOG);
    expect(errors(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.record).toMatchObject({
      resources: expect.arrayContaining([
        { fqn: "CireApi", kind: "api-worker", action: "create" },
        { fqn: "CireDb", kind: "d1", action: "adopted" },
      ]),
    });
  }, 30_000);

  test("GP2: refuses the first adoption when cire-api does not exist live, or lacks a required secret", () => {
    const missing = guard(ADOPTION_LOG, LIVE_DOMAINS, {
      ...LIVE_STATE,
      workers: {
        ...LIVE_STATE.workers,
        CireApi: { ...LIVE_STATE.workers.CireApi!, exists: false },
      },
    });
    expect(missing.exitCode).toBe(1);
    expect(errors(missing.stdout).join("\n")).toContain(
      "CireApi (api-worker) would be created: production adopts its API Workers, and the live read found none of its name",
    );
    const lacking = guard(ADOPTION_LOG, LIVE_DOMAINS, {
      ...LIVE_STATE,
      workers: {
        ...LIVE_STATE.workers,
        CireApi: { ...LIVE_STATE.workers.CireApi!, secrets: [] },
      },
    });
    expect(lacking.exitCode).toBe(1);
    expect(errors(lacking.stdout).join("\n")).toContain("cire-api-production lacks secrets");
  }, 30_000);

  test("G16: reads a real dev plan, every resource of which production declares too", () => {
    const result = guard(readFileSync(DEV_LOG, "utf8"));
    expect(errors(result.stdout)).toEqual([]);
    expect(result.record).toMatchObject({ stack: "cire", plan: "changes", counts: { update: 2 } });
  }, 30_000);

  test("G18: refuses the landing site's Worker giving up a host it holds beside its own", () => {
    const result = guard(PRODUCTION_LOG, {
      ...LIVE_DOMAINS,
      cire_landing: [...(LIVE_DOMAINS.cire_landing ?? []), "old.cireweddings.com"],
    });
    expect(result.exitCode).toBe(1);
    expect(errors(result.stdout)).toEqual([
      "::error::cire production plan refused: cire_landing's Worker would give up old.cireweddings.com; no release takes a production host off its Worker: remove it in the Cloudflare dashboard first",
    ]);
  }, 30_000);

  // A release that carries a migration plans the database as an update: the
  // migrate step applies the files its ledger lacks, and nothing else can
  // change on it while its read replication matches the declaration.
  const MIGRATION_LOG = [
    "[20:17:45.301] INFO: Plan: 1 to update",
    "[20:17:45.301] INFO: [CireDb] update",
    "",
  ].join("\n");

  test("GM1: allows the database's update when its ledger is whole, listing the ledger's counts", () => {
    const result = guard(MIGRATION_LOG, LIVE_DOMAINS, withLedger({ pending: 1 }));
    expect(errors(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "cire-db migration ledger (__alchemy_migrations): 12 rows, 12 match a migration file, 0 match none; 1 to apply, 0 of them older than the newest applied; Wrangler's ledger frozen",
    );
  }, 30_000);

  test("GM2: refuses the database's update when its ledger lacks a file the chain went on without, or its read replication would change", () => {
    const skipped = guard(MIGRATION_LOG, LIVE_DOMAINS, withLedger({ pending: 1, skipped: 1 }));
    expect(skipped.exitCode).toBe(1);
    expect(errors(skipped.stdout).join("\n")).toContain(
      "1 migration file of cire-db is missing from its ledger",
    );
    const replicated = guard(MIGRATION_LOG, LIVE_DOMAINS, {
      ...LIVE_STATE,
      databases: { CireDb: { ...LIVE_STATE.databases.CireDb!, readReplication: "disabled" } },
    });
    expect(replicated.exitCode).toBe(1);
    expect(errors(replicated.stdout).join("\n")).toContain(
      "cire-db's read replication is disabled live and auto declared, and the migrate step would change it",
    );
  }, 30_000);
});

/** The live state with cire-db's ledger counts changed by `change`. */
function withLedger(change: Partial<LedgerCounts>): LiveState {
  return {
    ...LIVE_STATE,
    databases: {
      CireDb: { ...LIVE_STATE.databases.CireDb!, ledger: { ...CONVERTED_LEDGER, ...change } },
    },
  };
}
