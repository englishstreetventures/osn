// Holds .github/workflows/deploy.yml to the secret inventory: each dev stack
// job hands its Alchemy deploy exactly the secrets its stack's Workers declare,
// and no step that installs or builds holds a secret or a Cloudflare
// credential. A secret the deploy step lacks fails the first deploy in
// requireSecrets(); one that reaches a build step reaches every dependency's
// install and build scripts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { accountSecrets, TIER_ACCOUNTS } from "../src/accounts";
import { tierSecrets } from "../src/secrets/inventory";
import { STACK_KEYS, STACK_STEP_SECRETS, STACK_WORKERS, type StackKey } from "../src/stacks";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly env?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly env?: Readonly<Record<string, string | boolean>>;
  readonly jobs: Readonly<Record<string, Job>>;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT = readFileSync(`${ROOT}.github/workflows/deploy.yml`, "utf8");
const workflow = Bun.YAML.parse(TEXT) as Workflow;
const jobs = Object.entries(workflow.jobs);
const allSteps = jobs.flatMap(([, job]) => job.steps ?? []);

/** The `secrets.NAME` names a workflow fragment reads, sorted. */
const secretsRead = (fragment: unknown): string[] =>
  [
    ...new Set(
      [...JSON.stringify(fragment ?? {}).matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].toSorted();

const stackJob = (key: StackKey): Job => {
  const job = workflow.jobs[`stack-${key}-dev`];
  if (job === undefined) throw new Error(`deploy.yml has no stack-${key}-dev job`);
  return job;
};

/** The dev Worker secrets a stack's Workers declare, required and optional. */
const workerSecrets = (key: StackKey): readonly string[] =>
  STACK_WORKERS[key].flatMap((worker) => {
    const row = tierSecrets(worker, "dev");
    return row.secrets.concat(row.optional);
  });

const INSTALLS_OR_BUILDS = /\bbun install\b|\bbun run build\b|guard-bundle-size/;
const isGuestSiteBuild = (step: Step): boolean =>
  /\bbun run build --filter=@cire\/invites\b/.test(step.run ?? "");

describe("W3: each stack's deploy step holds exactly its stack's secrets", () => {
  test.each(STACK_KEYS.map((key) => [key] as const))(
    "%s: its Workers' dev secrets, its own step secrets and the dev account's credentials",
    (key) => {
      const deploys = (stackJob(key).steps ?? []).filter(
        (step) => step.name === `Deploy the ${key} stack`,
      );
      expect(deploys).toHaveLength(1);
      const [deploy] = deploys;
      const own = [
        ...workerSecrets(key),
        ...STACK_STEP_SECRETS[key].filter((entry) => entry.step === "deploy").map((e) => e.name),
      ];
      expect(secretsRead(deploy)).toEqual(
        [...new Set([...own, ...accountSecrets("dev")])].toSorted(),
      );
      // The stack reads each secret from the environment by its own name.
      for (const name of own) expect(deploy?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
      expect(deploy?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(
        `\${{ secrets.${TIER_ACCOUNTS.dev.accountIdSecret} }}`,
      );
      expect(deploy?.env?.CLOUDFLARE_API_TOKEN).toBe(
        `\${{ secrets.${TIER_ACCOUNTS.dev.apiTokenSecret} }}`,
      );
    },
  );
});

describe("W3: no install or build step holds a secret", () => {
  test("no workflow- or job-level env reads a secret or sets a Cloudflare credential", () => {
    for (const env of [workflow.env, ...jobs.map(([, job]) => job.env)]) {
      expect(secretsRead(env)).toEqual([]);
      expect(Object.keys(env ?? {}).filter((name) => name.startsWith("CLOUDFLARE_"))).toEqual([]);
    }
  });

  test("an install or build step reads no secret and sets no Cloudflare credential; the guest site's build reads ASTRO_KEY alone", () => {
    const steps = allSteps.filter((step) => INSTALLS_OR_BUILDS.test(step.run ?? ""));
    expect(steps.some((step) => /\bbun install\b/.test(step.run ?? ""))).toBe(true);
    expect(steps.filter(isGuestSiteBuild)).toHaveLength(1);
    for (const step of steps) {
      expect({ step: step.name, secrets: secretsRead(step) }).toEqual({
        step: step.name,
        secrets: isGuestSiteBuild(step) ? ["ASTRO_KEY"] : [],
      });
      expect(Object.keys(step.env ?? {}).filter((name) => name.startsWith("CLOUDFLARE_"))).toEqual(
        [],
      );
    }
  });

  test("only the deploy, the deployment snapshot and compare, the smoke checks and the guest site's build read a secret", () => {
    // The deploy step and the guest site's build are held exactly above.
    const mayRead = (step: Step): readonly string[] => {
      if (step.id === "snapshot" || step.id === "deployments") return accountSecrets("dev");
      if (step.id?.startsWith("smoke_") === true) {
        return accountSecrets("dev").concat(["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]);
      }
      return [];
    };
    const others = allSteps.filter((step) => step.id !== "deploy" && !isGuestSiteBuild(step));
    expect(others.some((step) => step.id === "snapshot")).toBe(true);
    const strays = others.flatMap((step) =>
      secretsRead(step)
        .filter((name) => !mayRead(step).includes(name))
        .map((name) => `${step.name ?? step.id ?? "a step"}: ${name}`),
    );
    expect(strays).toEqual([]);
  });
});

describe("W8: deploy.yml reaches the dev account and no other", () => {
  test("the Cloudflare credentials it reads are exactly the dev account's", () => {
    const read = [
      ...new Set([...TEXT.matchAll(/secrets\.(CLOUDFLARE_[A-Z0-9_]+)/g)].map((m) => m[1])),
    ];
    expect(read.toSorted()).toEqual([...accountSecrets("dev")]);
  });

  test("every step that sets the Cloudflare variables sets them to the dev account's", () => {
    const dev: Readonly<Record<string, string>> = {
      CLOUDFLARE_ACCOUNT_ID: `\${{ secrets.${TIER_ACCOUNTS.dev.accountIdSecret} }}`,
      CLOUDFLARE_API_TOKEN: `\${{ secrets.${TIER_ACCOUNTS.dev.apiTokenSecret} }}`,
    };
    const set = allSteps.flatMap((step) =>
      Object.entries(step.env ?? {}).filter(([name]) => Object.hasOwn(dev, name)),
    );
    expect(set.length).toBeGreaterThan(0);
    expect(set.filter(([name, value]) => value !== dev[name])).toEqual([]);
  });
});

interface DryRunTask {
  readonly taskId: string;
  readonly environmentVariables: {
    readonly configured: readonly string[] | null;
    readonly passthrough: readonly string[] | null;
  };
}

describe("W11: the guest site's build sees ASTRO_KEY", () => {
  // Turborepo runs `build` in strict env mode, where a task sees only the
  // variables turbo.json names. Unnamed, ASTRO_KEY never reaches `astro
  // build`, Astro makes a new key for each build, and no second deploy can
  // plan "no change".
  test("turbo passes ASTRO_KEY through to @cire/invites#build without hashing it", () => {
    const run = Bun.spawnSync(
      [`${ROOT}node_modules/.bin/turbo`, "run", "build", "--filter=@cire/invites", "--dry=json"],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ASTRO_KEY: "a-fixed-key",
          DO_NOT_TRACK: "1",
          TURBO_TELEMETRY_DISABLED: "1",
        },
      },
    );
    expect(run.exitCode).toBe(0);
    const dry = JSON.parse(run.stdout.toString()) as { readonly tasks: readonly DryRunTask[] };
    const task = dry.tasks.find((candidate) => candidate.taskId === "@cire/invites#build");
    const names = (list: readonly string[] | null) =>
      (list ?? []).map((entry) => entry.split("=")[0]);
    expect(names(task?.environmentVariables.passthrough ?? null)).toContain("ASTRO_KEY");
    expect(names(task?.environmentVariables.configured ?? null)).not.toContain("ASTRO_KEY");
  });
});
