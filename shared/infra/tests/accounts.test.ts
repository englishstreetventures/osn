import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  accountSecrets,
  DEV_READONLY_CREDENTIALS,
  forbiddenCredentials,
  knownCredentials,
  REPOSITORY_CREDENTIALS,
  requiredCredentials,
  TIER_ACCOUNTS,
} from "../src/accounts";
import { githubExpectations } from "../src/secrets/compare";
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

  test("each Environment is forbidden the other tier's credentials and the retired dev ones, and nothing it must hold", () => {
    expect(forbiddenCredentials("dev")).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_TOKEN_DEV",
    ]);
    expect(forbiddenCredentials("production")).toEqual([
      "CLOUDFLARE_API_TOKEN_DEV",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
    // A name both forbidden and expected would fail the check whether or not
    // the Environment held it.
    for (const tier of TIERS) {
      const expected = githubExpectations(tier);
      expect({
        tier,
        both: forbiddenCredentials(tier).filter((name) => expected.includes(name)),
      }).toEqual({ tier, both: [] });
    }
  });

  test("I4: the dev read-only token is classified, required in dev and forbidden in production", () => {
    // free-tier-ceiling-alert.yml's dev job fails every night without it.
    expect(knownCredentials()).toContain("CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY");
    expect(requiredCredentials("dev")).toEqual(
      [...accountSecrets("dev"), "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY"].toSorted(),
    );
    expect(forbiddenCredentials("production")).toContain(
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
    );
    expect(requiredCredentials("production")).toEqual(accountSecrets("production"));
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

  test("only alchemy-state.yml, deploy.yml and free-tier-ceiling-alert.yml reach the dev account", () => {
    const allowed = new Set(["alchemy-state.yml", "deploy.yml", "free-tier-ceiling-alert.yml"]);
    const dev = new Set([...accountSecrets("dev"), ...DEV_READONLY_CREDENTIALS]);
    for (const file of workflowFiles.filter((candidate) => !allowed.has(candidate))) {
      const reached = cloudflareSecrets(file).filter((name) => dev.has(name));
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
      const check = run.indexOf(`bun run token:check -- --tier ${tier}`);
      expect(check, `${tier}`).toBeGreaterThan(-1);
      for (const command of ["bun run state:bootstrap", "bun run state:check"]) {
        expect(run.indexOf(command), `${tier} ${command}`).toBeGreaterThan(check);
      }
    }
  });

  test("the dev step gives token:check the dev domain, whose zone the dev token must act on", () => {
    const step = steps.find((candidate) => candidate.if === "inputs.tier == 'dev'");
    expect(step?.env?.DEV_DOMAIN).toBe("${{ vars.DEV_DOMAIN }}");
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

const ALERT = fileURLToPath(
  new URL("../../../.github/workflows/free-tier-ceiling-alert.yml", import.meta.url),
);

interface AlertStep extends WorkflowStep {
  readonly "continue-on-error"?: boolean;
}

interface AlertJob {
  readonly environment?: string;
  readonly steps: readonly AlertStep[];
}

describe("the free-tier ceiling alert", () => {
  const alert = Bun.YAML.parse(readFileSync(ALERT, "utf8")) as {
    readonly jobs: Readonly<Record<string, AlertJob>>;
  };
  /** The one step of `job` that runs the check. */
  const checkStep = (job: AlertJob | undefined): AlertStep | undefined => {
    const steps = (job?.steps ?? []).filter((step) =>
      step.run?.includes("scripts/check-free-tier-ceilings.ts"),
    );
    expect(steps).toHaveLength(1);
    return steps[0];
  };

  test("F6: one job per account", () => {
    expect(Object.keys(alert.jobs).toSorted()).toEqual(["dev", "production"]);
  });

  test("F6: the production job reads the repository's read-only pair and passes --account production", () => {
    const job = alert.jobs.production;
    expect(job?.environment).toBeUndefined();
    expect(secretsRead(job)).toEqual([...REPOSITORY_CREDENTIALS].toSorted());
    const step = checkStep(job);
    expect(step?.env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    expect(step?.env?.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN_READONLY }}");
    expect(step?.run).toContain("--account production");
  });

  test("F6: the dev job runs in dev and reads exactly the dev account id and read-only token", () => {
    const job = alert.jobs.dev;
    expect(job?.environment).toBe(TIER_ACCOUNTS.dev.environment);
    expect(secretsRead(job)).toEqual(
      [TIER_ACCOUNTS.dev.accountIdSecret, ...DEV_READONLY_CREDENTIALS].toSorted(),
    );
    const step = checkStep(job);
    expect(step?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(
      `\${{ secrets.${TIER_ACCOUNTS.dev.accountIdSecret} }}`,
    );
    expect(step?.env?.CLOUDFLARE_API_TOKEN).toBe(`\${{ secrets.${DEV_READONLY_CREDENTIALS[0]} }}`);
    expect(step?.run).toContain("--account dev");
    // An empty dev secret must fail the job (the script names both secrets).
    expect(step?.["continue-on-error"]).toBeUndefined();
  });
});
