// `bun run plan:guard` as the production release runs it in zap/infra: the
// stack's entry, the `--` before its arguments, and its exit code, over
// production plans in the shape `deploy --dry-run` logs them, with the live
// read of zap-api and its database.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { LiveState } from "../../../shared/infra/src/production-live";
import { matchingLive } from "../../../shared/infra/tests/support/live-state";
import { PRODUCTION_ADOPTED, PRODUCTION_DOMAINS } from "../src/declaration";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** The first release that adopts zap-api and its database. */
const ADOPTION_LOG = [
  "[20:17:45.301] INFO: Plan: 1 to create, 1 to adopted, 1 binding changes",
  "[20:17:45.301] INFO: [ZapApi] create",
  "[20:17:45.301] INFO: [ZapApi/DB] create",
  "[20:17:45.301] INFO: [ZapDb] adopted",
  "",
].join("\n");

/** A later release that changes nothing. */
const NO_CHANGES = [
  "[20:17:45.301] INFO: Plan: no changes",
  "[20:17:45.301] INFO: [ZapApi] noop",
  "[20:17:45.301] INFO: [ZapDb] noop",
  "",
].join("\n");

/** zap-api's live host, the one its declaration gives it. */
const LIVE_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(PRODUCTION_DOMAINS).map(([surface, host]) => [
    surface,
    host === null || host === undefined ? [] : [host],
  ]),
);

const LIVE_STATE: LiveState = matchingLive(PRODUCTION_ADOPTED);

function guard(log: string, state: LiveState = LIVE_STATE) {
  const dir = mkdtempSync(join(tmpdir(), "zap-plan-guard-"));
  try {
    const logFile = join(dir, "zap.log");
    const out = join(dir, "plan-guard", "zap.json");
    const domains = join(dir, "domains.json");
    const liveFile = join(dir, "live.json");
    writeFileSync(logFile, log);
    writeFileSync(domains, JSON.stringify(LIVE_DOMAINS));
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

const errors = (stdout: string) =>
  stdout.split("\n").filter((line) => line.startsWith("::error::"));

describe("plan:guard, the zap stack's production plan guard", () => {
  test("GP1: allows the first adoption of zap-api, which exists live, and a later plan that changes nothing", () => {
    const adoption = guard(ADOPTION_LOG);
    expect(errors(adoption.stdout)).toEqual([]);
    expect(adoption.exitCode).toBe(0);
    expect(adoption.record).toEqual({
      stack: "zap",
      plan: "changes",
      counts: { "binding changes": 1, adopted: 1, create: 1 },
      resources: [
        { fqn: "ZapApi", kind: "api-worker", action: "create" },
        { fqn: "ZapDb", kind: "d1", action: "adopted" },
      ],
      bindings: [{ fqn: "ZapApi/DB", action: "create" }],
      domains: [],
    });
    expect(guard(NO_CHANGES).exitCode).toBe(0);
  }, 30_000);

  test("GZ1: refuses zap-api while it holds the retired GrowthBook key, sending the owner to delete it", () => {
    const zapApi = LIVE_STATE.workers.ZapApi!;
    const result = guard(ADOPTION_LOG, {
      ...LIVE_STATE,
      workers: { ZapApi: { ...zapApi, secrets: [...zapApi.secrets, "GROWTHBOOK_CLIENT_KEY"] } },
    });
    expect(result.exitCode).toBe(1);
    expect(errors(result.stdout)).toEqual([
      "::error::zap production plan refused: zap-api-production holds secrets it must not: GROWTHBOOK_CLIENT_KEY; delete each with wrangler secret delete before releasing",
    ]);
  }, 30_000);

  test("GZ2: refuses creating zap-db-prod, whose name would then match nothing live", () => {
    const result = guard(
      ["[20:17:45.301] INFO: Plan: 1 to create", "[20:17:45.301] INFO: [ZapDb] create", ""].join(
        "\n",
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(errors(result.stdout).join("\n")).toContain("ZapDb (d1) would be created");
  }, 30_000);
});
