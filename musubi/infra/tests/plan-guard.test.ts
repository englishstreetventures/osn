// `bun run plan:guard` as the production release runs it in musubi/infra: the
// stack's entry, the `--` before its arguments, and its exit code, over
// production plans in the shape `deploy --dry-run` logs them, with the live
// read of osn-api and its database, and over a real dev deploy log
// (shared/infra/tests/fixtures).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { LiveState } from "../../../shared/infra/src/production-live";
import { matchingLive } from "../../../shared/infra/tests/support/live-state";
import { PRODUCTION_ADOPTED, PRODUCTION_DOMAINS } from "../src/declaration";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DEV_LOG = fileURLToPath(
  new URL("../../../shared/infra/tests/fixtures/alchemy-dev-musubi.log", import.meta.url),
);

/** The production plan step's log: Alchemy's records, the plan lines last. */
const PRODUCTION_LOG = [
  "$ CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage production --dry-run",
  "[20:17:41.001] INFO: Plan · production",
  "[20:17:44.120] INFO: Computing plan",
  "[20:17:45.300] INFO: Plan ready (4.2s)",
  "[20:17:45.301] INFO: Plan: no changes",
  "[20:17:45.301] INFO: [MusubiLanding] noop",
  "[20:17:45.301] INFO: [MusubiSocial] noop",
  "[20:17:45.301] INFO: [OsnApi] noop",
  "[20:17:45.301] INFO: [OsnDb] noop",
  "",
].join("\n");

/** The first release that adopts osn-api and its database. */
const ADOPTION_LOG = [
  "[20:17:45.301] INFO: Plan: 1 to create, 1 to adopted, 1 binding changes",
  "[20:17:45.301] INFO: [MusubiLanding] noop",
  "[20:17:45.301] INFO: [MusubiSocial] noop",
  "[20:17:45.301] INFO: [OsnApi] create",
  "[20:17:45.301] INFO: [OsnApi/COORDINATION] create",
  "[20:17:45.301] INFO: [OsnDb] adopted",
  "",
].join("\n");

/**
 * The hosts each Worker holds now, as the domains step reads them: each the
 * host the declaration gives it, so no domain changes, whatever
 * PRODUCTION_HOST_HOLDS holds.
 */
const LIVE_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(PRODUCTION_DOMAINS).map(([surface, host]) => [
    surface,
    host === null || host === undefined ? [] : [host],
  ]),
);

/** The live read of osn-api and its database, each as its declaration states it. */
const LIVE_STATE: LiveState = matchingLive(PRODUCTION_ADOPTED);

/** Runs the entry over `log` as the workflow's guard step does, with no step summary file. */
function guard(log: string, state: LiveState = LIVE_STATE) {
  const dir = mkdtempSync(join(tmpdir(), "musubi-plan-guard-"));
  try {
    const logFile = join(dir, "musubi.log");
    const out = join(dir, "plan-guard", "musubi.json");
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

describe("plan:guard, the musubi stack's production plan guard", () => {
  test("G16: allows a plan that changes nothing, exiting 0 and keeping its record", () => {
    const result = guard(PRODUCTION_LOG);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The guard allows this plan.");
    expect(errors(result.stdout)).toEqual([]);
    expect(result.record).toEqual({
      stack: "musubi",
      plan: "no-changes",
      counts: {},
      resources: [
        { fqn: "MusubiLanding", kind: "custom-domain", action: "noop" },
        { fqn: "MusubiSocial", kind: "custom-domain", action: "noop" },
        { fqn: "OsnApi", kind: "api-worker", action: "noop" },
        { fqn: "OsnDb", kind: "d1", action: "noop" },
      ],
      bindings: [],
      domains: [],
    });
  }, 30_000);

  test("GP1: allows the first adoption of osn-api, which exists live with its coordination class", () => {
    const result = guard(ADOPTION_LOG);
    expect(errors(result.stdout)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("GP3: refuses the first adoption while osn-api hosts a Durable Object class no binding names, or lacks the pairwise salt", () => {
    const osnApi = LIVE_STATE.workers.OsnApi!;
    const extraClass = guard(ADOPTION_LOG, {
      ...LIVE_STATE,
      workers: { OsnApi: { ...osnApi, durableObjectClasses: ["CoordinationStore", "OldStore"] } },
    });
    expect(extraClass.exitCode).toBe(1);
    expect(errors(extraClass.stdout).join("\n")).toContain(
      "hosts Durable Object classes no declared binding names: OldStore",
    );
    const noSalt = guard(PRODUCTION_LOG, {
      ...LIVE_STATE,
      workers: {
        OsnApi: {
          ...osnApi,
          secrets: osnApi.secrets.filter((name) => name !== "OSN_PAIRWISE_SALT"),
        },
      },
    });
    expect(noSalt.exitCode).toBe(1);
    expect(errors(noSalt.stdout).join("\n")).toContain(
      "osn-api-production lacks secrets it needs on production: OSN_PAIRWISE_SALT",
    );
  }, 30_000);

  test("GP4: on a release that adopts nothing, refuses a live Durable Object class no declared binding names", () => {
    // What a declaration that dropped its binding looks like after the first
    // release: the plan shows an update, and the live Worker still hosts the class.
    const osnApi = LIVE_STATE.workers.OsnApi!;
    const result = guard(
      [
        "[20:17:45.301] INFO: Plan: 1 to update",
        "[20:17:45.301] INFO: [MusubiLanding] noop",
        "[20:17:45.301] INFO: [MusubiSocial] noop",
        "[20:17:45.301] INFO: [OsnApi] update",
        "[20:17:45.301] INFO: [OsnDb] noop",
        "",
      ].join("\n"),
      {
        ...LIVE_STATE,
        workers: {
          ...LIVE_STATE.workers,
          OsnApi: {
            ...osnApi,
            durableObjectClasses: [...osnApi.durableObjectClasses, "RetiredStore"],
          },
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(errors(result.stdout).join("\n")).toContain(
      "osn-api-production hosts Durable Object classes no declared binding names: RetiredStore; the deploy would delete each, with its storage",
    );
  }, 30_000);

  test("G16: reads a real dev plan, every resource of which production declares too", () => {
    const result = guard(readFileSync(DEV_LOG, "utf8"));
    expect(errors(result.stdout)).toEqual([]);
    expect(result.record).toMatchObject({ stack: "musubi", plan: "no-changes" });
  }, 30_000);
});
