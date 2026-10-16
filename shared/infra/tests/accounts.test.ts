import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  accountSecrets,
  allowedCredentials,
  forbiddenCredentials,
  knownCredentials,
  TIER_ACCOUNTS,
} from "../src/accounts";
import type { Tier } from "../src/stage";

const TIERS: readonly Tier[] = ["dev", "production"];
const WORKFLOWS = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const workflowFiles = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

/** The `secrets.CLOUDFLARE_*` names one workflow file reads, sorted. */
function cloudflareSecrets(file: string): string[] {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  return [
    ...new Set([...text.matchAll(/secrets\.(CLOUDFLARE_[A-Z0-9_]+)/g)].map((match) => match[1])),
  ].toSorted();
}

describe("TIER_ACCOUNTS", () => {
  test("each tier's credentials live in the GitHub Environment of the same name", () => {
    for (const tier of TIERS) expect(TIER_ACCOUNTS[tier].environment).toBe(tier);
  });

  test("the two tiers share no credential name, so neither can read the other's account", () => {
    const dev = accountSecrets("dev");
    for (const name of accountSecrets("production")) expect(dev).not.toContain(name);
  });

  test("names are environment-variable shaped and returned sorted", () => {
    for (const tier of TIERS) {
      for (const names of [
        accountSecrets(tier),
        allowedCredentials(tier),
        forbiddenCredentials(tier),
      ]) {
        expect(names).toEqual([...names].toSorted());
        for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  test("each Environment is forbidden the other tier's credentials and none of its own", () => {
    expect(forbiddenCredentials("dev")).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(forbiddenCredentials("production")).toEqual([
      "CLOUDFLARE_API_TOKEN_DEV",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
    for (const tier of TIERS) {
      for (const name of [...accountSecrets(tier), ...allowedCredentials(tier)]) {
        expect(forbiddenCredentials(tier)).not.toContain(name);
      }
    }
  });
});

describe("the credentials the workflows read", () => {
  test("every Cloudflare credential any workflow reads is one this module classifies", () => {
    const read = [...new Set(workflowFiles.flatMap(cloudflareSecrets))].toSorted();
    expect(read.filter((name) => !knownCredentials().includes(name))).toEqual([]);
  });

  test("production's Alchemy credentials are the ones the production release deploys with today", () => {
    expect(cloudflareSecrets("production-release.yml")).toEqual([...accountSecrets("production")]);
  });

  test("only the state-store workflow reaches the dev account", () => {
    for (const file of workflowFiles.filter((candidate) => candidate !== "alchemy-state.yml")) {
      const reached = cloudflareSecrets(file).filter((name) =>
        accountSecrets("dev").includes(name),
      );
      expect({ file, reached }).toEqual({ file, reached: [] });
    }
  });
});
