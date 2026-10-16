import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertDevDeployTarget,
  DeployTargetError,
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
    for (const blank of [undefined, "", "  "]) {
      expect(() => assertDevDeployTarget("dev", { ...ok, CLOUDFLARE_ACCOUNT_ID: blank })).toThrow(
        DeployTargetError,
      );
      expect(
        messageOf(() => assertDevDeployTarget("dev", { ...ok, CLOUDFLARE_ACCOUNT_ID: blank })),
      ).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
      expect(
        messageOf(() => assertDevDeployTarget("dev", { ...ok, CLOUDFLARE_API_TOKEN: blank })),
      ).toMatch(/CLOUDFLARE_API_TOKEN/);
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

describe("refuseDotEnvFiles", () => {
  test("T5: refuses a stack directory holding a .env file Bun would load", () => {
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      const dir = mkdtempSync(join(tmpdir(), "stack-"));
      writeFileSync(join(dir, name), "X=1");
      expect(() => refuseDotEnvFiles(dir)).toThrow(DeployTargetError);
      expect(() => refuseDotEnvFiles(dir)).toThrow(name);
    }
    expect(() => refuseDotEnvFiles(mkdtempSync(join(tmpdir(), "stack-")))).not.toThrow();
  });
});
