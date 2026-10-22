// Holds the secret inventory to what the workflows read. A job bound to a
// GitHub Environment reads that Environment's secrets, so every name such a
// job reads must be one `secrets:check-github` expects for that tier, and the
// names only workflows read (no Worker holds them, none is a credential) must
// be exactly the tier's WORKFLOW_SECRETS. A name the check does not know
// passes it while the job that reads it fails.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { requiredCredentials } from "../../src/accounts";
import { githubExpectations } from "../../src/secrets/compare";
import { SECRET_INVENTORY, WORKFLOW_SECRETS } from "../../src/secrets/inventory";
import type { Tier } from "../../src/stage";

const TIERS: readonly Tier[] = ["dev", "production"];
const WORKFLOWS = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url));

interface Step {
  readonly name?: string;
  readonly if?: string;
}

interface Job {
  readonly environment?: unknown;
  readonly env?: unknown;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on?: {
    readonly workflow_dispatch?: {
      readonly inputs?: { readonly tier?: { readonly options?: readonly string[] } };
    };
  };
  readonly jobs: Readonly<Record<string, Job>>;
}

/** Every `secrets.NAME` a workflow fragment names, in any expression. */
const secretsRead = (fragment: unknown): string[] => [
  ...new Set(
    [...JSON.stringify(fragment ?? {}).matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map(
      (match) => match[1] ?? "",
    ),
  ),
];

const isTier = (value: unknown): value is Tier => value === "dev" || value === "production";

interface Read {
  readonly where: string;
  readonly name: string;
  /** The Environment the read resolves in, or why it cannot be placed. */
  readonly tier: Tier | { readonly unresolved: string };
}

/**
 * Each secret read by a job bound to an Environment, with the tier it resolves
 * in. A literal `environment:` names the tier. `${{ inputs.tier }}` resolves
 * to the dispatch input's only option, or, per step, to a literal
 * `if: inputs.tier == '<tier>'`. Anything else cannot be placed and is
 * reported as such, so a new form fails here rather than going unchecked.
 */
function environmentReads(file: string, workflow: Workflow): Read[] {
  const options = workflow.on?.workflow_dispatch?.inputs?.tier?.options ?? [];
  return Object.entries(workflow.jobs).flatMap(([id, job]): Read[] => {
    if (job.environment === undefined) return [];
    const where = `${file} ${id}`;
    const environment = job.environment;
    if (isTier(environment)) {
      return secretsRead(job).map((name) => ({ where, name, tier: environment }));
    }
    if (job.environment !== "${{ inputs.tier }}") {
      return secretsRead(job).map((name) => ({
        where,
        name,
        tier: { unresolved: `environment ${JSON.stringify(job.environment)}` },
      }));
    }
    const [only] = options;
    if (options.length === 1 && isTier(only)) {
      return secretsRead(job).map((name) => ({ where, name, tier: only }));
    }
    const jobLevel: Read[] = secretsRead({ ...job, steps: [] }).map((name) => ({
      where,
      name,
      tier: { unresolved: "a job-level read in a job whose tier is chosen at dispatch" },
    }));
    const stepLevel = (job.steps ?? []).flatMap((step) => {
      const tier = /^inputs\.tier == '([a-z]+)'$/.exec(step.if ?? "")?.[1];
      return secretsRead(step).map((name) => ({
        where: `${where} "${step.name ?? "a step"}"`,
        name,
        tier: isTier(tier) ? tier : { unresolved: `step if ${JSON.stringify(step.if)}` },
      }));
    });
    return jobLevel.concat(stepLevel);
  });
}

const READS = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) =>
    environmentReads(file, Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow),
  );

/** The Worker secrets, required and optional, every Worker holds on `tier`. */
const workerSecrets = (tier: Tier): Set<string> =>
  new Set(
    SECRET_INVENTORY.flatMap((entry) =>
      entry.tiers[tier].secrets.concat(entry.tiers[tier].optional),
    ),
  );

describe("the secrets jobs bound to a GitHub Environment read", () => {
  test("each read resolves to one tier", () => {
    expect(READS.length).toBeGreaterThan(0);
    expect(READS.filter((read) => !isTier(read.tier))).toEqual([]);
  });

  test.each(TIERS.map((tier) => [tier] as const))(
    "%s: every name a job reads is one secrets:check-github expects there, required or optional",
    (tier) => {
      const known = new Set([...githubExpectations(tier), ...workerSecrets(tier)]);
      const strays = READS.filter((read) => read.tier === tier && !known.has(read.name)).map(
        (read) => `${read.where}: ${read.name}`,
      );
      expect(strays).toEqual([]);
    },
  );

  test.each(TIERS.map((tier) => [tier] as const))(
    "%s: WORKFLOW_SECRETS is exactly what its jobs read beyond Worker secrets and credentials",
    (tier) => {
      const others = new Set([...workerSecrets(tier), ...requiredCredentials(tier)]);
      const workflowOnly = [
        ...new Set(
          READS.filter((read) => read.tier === tier && !others.has(read.name)).map(
            (read) => read.name,
          ),
        ),
      ].toSorted();
      expect([...WORKFLOW_SECRETS[tier]].toSorted()).toEqual(workflowOnly);
    },
  );
});
