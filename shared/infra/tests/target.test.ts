import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertDevDeployTarget,
  DeployTargetError,
  DOT_ENV_FILES,
  refuseDotEnvFiles,
  StageNotDeclaredError,
} from "../src/target";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "placeholder-token";
const ok = {
  OSN_DEPLOY_TIER: "dev",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
};

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

/** The message `run` throws, checked to carry no credential's value: messages name variables only. */
function messageOf(run: () => unknown): string {
  const message = thrownMessage(run);
  expect(message).not.toContain(ACCOUNT_ID);
  expect(message).not.toContain(TOKEN);
  return message;
}

describe("assertDevDeployTarget", () => {
  test("T1: refuses a run with no OSN_DEPLOY_TIER", () => {
    expect(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: undefined })).toThrow(
      DeployTargetError,
    );
    expect(
      messageOf(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: undefined })),
    ).toMatch(/OSN_DEPLOY_TIER/);
  });

  test("T2: refuses a run whose OSN_DEPLOY_TIER names the other tier", () => {
    expect(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: "production" })).toThrow(
      DeployTargetError,
    );
    expect(
      messageOf(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: "production" })),
    ).toMatch(/OSN_DEPLOY_TIER/);
  });

  test("T3: refuses a run missing either credential, which would fall back to a stored profile", () => {
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
      for (const blank of [undefined, "", "  "]) {
        const env = { ...ok, [name]: blank };
        expect(() => assertDevDeployTarget("dev", env)).toThrow(DeployTargetError);
        // The message opens by naming the variable that is missing, not just any credential.
        expect(messageOf(() => assertDevDeployTarget("dev", env))).toMatch(
          new RegExp(`^${name} is unset`),
        );
      }
    }
  });

  test("T4: refuses every production stage until phase P3", () => {
    expect(() =>
      assertDevDeployTarget("production", { ...ok, OSN_DEPLOY_TIER: "production" }),
    ).toThrow(StageNotDeclaredError);
    expect(
      messageOf(() =>
        assertDevDeployTarget("production", { ...ok, OSN_DEPLOY_TIER: "production" }),
      ),
    ).toMatch(/P3/);
  });
});

/** Every `.env` file name Bun knows; the probe below finds which of them it loads. */
const DOT_ENV_CANDIDATES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/**
 * The `.env` files the installed Bun loads from its working directory with
 * NODE_ENV unset (as `bunx --bun alchemy` may start) or set to each mode.
 */
function filesBunLoads(): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "stack-"));
  DOT_ENV_CANDIDATES.forEach((name, index) => {
    writeFileSync(join(dir, name), `OSN_DOTENV_PROBE_${index}=1\n`);
  });
  const probe =
    'process.stdout.write(Object.keys(process.env).filter((key) => key.startsWith("OSN_DOTENV_PROBE_")).join(","))';
  const loaded = new Set<string>();
  for (const mode of [undefined, "development", "production", "test"]) {
    const env =
      mode === undefined ? { PATH: process.env.PATH } : { PATH: process.env.PATH, NODE_ENV: mode };
    const keys = Bun.spawnSync(["bun", "-e", probe], { cwd: dir, env }).stdout.toString();
    for (const key of keys.split(",").filter((candidate) => candidate !== "")) {
      loaded.add(DOT_ENV_CANDIDATES[Number(key.slice("OSN_DOTENV_PROBE_".length))]);
    }
  }
  return [...loaded].toSorted();
}

describe("refuseDotEnvFiles", () => {
  test("T5: refuses a stack directory holding any .env file Bun would load, naming it", () => {
    const loaded = filesBunLoads();
    expect(loaded).toContain(".env");
    expect(loaded.filter((name) => !DOT_ENV_FILES.includes(name))).toEqual([]);
    for (const name of DOT_ENV_FILES) {
      const dir = mkdtempSync(join(tmpdir(), "stack-"));
      writeFileSync(join(dir, name), "X=1");
      expect(() => refuseDotEnvFiles(dir)).toThrow(DeployTargetError);
      expect(thrownMessage(() => refuseDotEnvFiles(dir)).startsWith(`${name} in ${dir} `)).toBe(
        true,
      );
    }
    expect(() => refuseDotEnvFiles(mkdtempSync(join(tmpdir(), "stack-")))).not.toThrow();
  });
});
