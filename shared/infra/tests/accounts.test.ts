import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  accountSecrets,
  allowedCredentials,
  DEV_READONLY_CREDENTIALS,
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
  test("the two tiers share no credential name, so neither can read the other's account", () => {
    const dev = accountSecrets("dev");
    for (const name of accountSecrets("production")) expect(dev).not.toContain(name);
  });

  test("each Environment is forbidden the other tier's credentials and none of its own", () => {
    expect(forbiddenCredentials("dev")).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(forbiddenCredentials("production")).toEqual([
      "CLOUDFLARE_API_TOKEN_DEV",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
    for (const tier of TIERS) {
      for (const name of [...accountSecrets(tier), ...allowedCredentials(tier)]) {
        expect(forbiddenCredentials(tier)).not.toContain(name);
      }
    }
  });

  test("I4: the dev read-only token is classified, allowed in dev and forbidden in production", () => {
    expect(knownCredentials()).toContain("CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY");
    expect(allowedCredentials("dev")).toContain("CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY");
    expect(forbiddenCredentials("production")).toContain(
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
    );
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

  // Off until deploy.yml deploys the dev stacks (englishstreetventures/osn#1553); it then replaces the next test.
  // oxlint-disable-next-line vitest/warn-todo -- turned on in the same change that makes deploy.yml read the dev account
  test.todo("only alchemy-state.yml, deploy.yml and free-tier-ceiling-alert.yml reach the dev account", () => {
    const allowed = new Set(["alchemy-state.yml", "deploy.yml", "free-tier-ceiling-alert.yml"]);
    const dev = new Set([...accountSecrets("dev"), ...DEV_READONLY_CREDENTIALS]);
    for (const file of workflowFiles.filter((candidate) => !allowed.has(candidate))) {
      const reached = cloudflareSecrets(file).filter((name) => dev.has(name));
      expect({ file, reached }).toEqual({ file, reached: [] });
    }
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

const WORKFLOW = fileURLToPath(
  new URL("../../../.github/workflows/alchemy-state.yml", import.meta.url),
);

interface WorkflowStep {
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
}

interface StateWorkflow {
  readonly env?: Readonly<Record<string, string | boolean>>;
  readonly on: {
    readonly workflow_dispatch: {
      readonly inputs: { readonly tier: { readonly options: readonly string[] } };
    };
  };
  readonly jobs: {
    readonly state: {
      readonly environment: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly steps: readonly WorkflowStep[];
    };
  };
}

/** The `${{ secrets.NAME }}` names a workflow fragment reads, sorted. Plain environment variable names do not count. */
const secretsRead = (fragment: unknown): string[] =>
  [
    ...new Set(
      [...JSON.stringify(fragment ?? {}).matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].toSorted();

describe("the Alchemy state store workflow", () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as StateWorkflow;
  const { steps } = workflow.jobs.state;

  test("offers exactly the two tiers and runs in the chosen tier's Environment", () => {
    expect([...workflow.on.workflow_dispatch.inputs.tier.options].toSorted()).toEqual([
      "dev",
      "production",
    ]);
    expect(workflow.jobs.state.environment).toBe("${{ inputs.tier }}");
  });

  test("each tier's step reads exactly that tier's credential secrets, as the variables Alchemy reads", () => {
    for (const tier of TIERS) {
      expect(steps.filter((candidate) => candidate.if === `inputs.tier == '${tier}'`)).toHaveLength(
        1,
      );
      const step = steps.find((candidate) => candidate.if === `inputs.tier == '${tier}'`);
      expect(step, `${tier}`).toBeDefined();
      expect(secretsRead(step), `${tier}`).toEqual([...accountSecrets(tier)]);
      expect(step?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(
        `\${{ secrets.${TIER_ACCOUNTS[tier].accountIdSecret} }}`,
      );
      expect(step?.env?.CLOUDFLARE_API_TOKEN).toBe(
        `\${{ secrets.${TIER_ACCOUNTS[tier].apiTokenSecret} }}`,
      );
    }
  });

  test("each tier's step checks its token reaches only its own account before Alchemy runs", () => {
    for (const tier of TIERS) {
      const run = steps.find((candidate) => candidate.if === `inputs.tier == '${tier}'`)?.run ?? "";
      const check = run.indexOf("bun run token:check");
      expect(check, `${tier}`).toBeGreaterThan(-1);
      for (const command of ["bun run state:bootstrap", "bun run state:check"]) {
        expect(run.indexOf(command), `${tier} ${command}`).toBeGreaterThan(check);
      }
    }
  });

  test("no secret is read anywhere else in the workflow", () => {
    const tierSteps = new Set(
      TIERS.map((tier) => steps.find((step) => step.if === `inputs.tier == '${tier}'`)),
    );
    const rest = {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        state: { ...workflow.jobs.state, steps: steps.filter((step) => !tierSteps.has(step)) },
      },
    };
    expect(JSON.stringify(rest)).not.toMatch(/secrets/i);
  });
});
