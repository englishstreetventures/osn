// Holds .github/workflows/deploy.yml to the secret inventory: each dev stack
// job hands its Alchemy deploy exactly the secrets its stack's Workers declare,
// and no step that installs or builds holds a secret or a Cloudflare
// credential. A secret the deploy step lacks fails the first deploy in
// requireSecrets(); one that reaches a build step reaches every dependency's
// install and build scripts. It also holds turbo to handing a build the
// values the build must see: ASTRO_KEY unhashed, OSN_DEPLOY_TIER hashed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { accountSecrets, PAGES_DNS_CREDENTIALS, TIER_ACCOUNTS } from "../src/accounts";
import { tierSecrets } from "../src/secrets/inventory";
import { STACK_KEYS, STACK_STEP_SECRETS, STACK_WORKERS, type StackKey } from "../src/stacks";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly "continue-on-error"?: boolean;
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

  test("only the token check, the seed derivation, the deploy, the deployment snapshot and compare, the smoke checks, the guest route comparison and the guest site's build read a secret", () => {
    // The deploy step and the guest site's build are held exactly above, the
    // musubi job's cire_seed step under DV1.
    const mayRead = (step: Step): readonly string[] => {
      if (step.id === "token" || step.id === "snapshot" || step.id === "deployments") {
        return accountSecrets("dev");
      }
      if (step.id === "cire_seed") {
        return STACK_KEYS.flatMap((key) => STACK_STEP_SECRETS[key])
          .filter((entry) => entry.step === "cire_seed")
          .map((entry) => entry.name);
      }
      if (step.id?.startsWith("smoke_") === true) {
        return accountSecrets("dev").concat(["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]);
      }
      // The Access token alone: it starts `wrangler dev`, which must never
      // hold a Cloudflare credential.
      if (step.id === "parity_cire_invites") {
        return ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"];
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

describe("DV1: the musubi deploy step holds none of cire's seed secrets; the cire_seed step alone does", () => {
  // osn-api's seed needs only a hash of cire's OIDC client secret and the
  // public half of cire-api's ARC key. The step that runs Alchemy, and every
  // dependency it loads, never holds either secret. A value osn-api and
  // cire-api share (SHARED_SECRET_VALUES) is osn-api's own secret as well, so
  // W3 above gives it to this step.
  const CIRE_SEED_SECRETS = [
    "CIRE_API_ARC_KEY_ID",
    "CIRE_API_ARC_PRIVATE_KEY",
    "CIRE_OIDC_CLIENT_SECRET",
  ];
  const steps = stackJob("musubi").steps ?? [];
  const indexOf = (id: string): number => steps.findIndex((step) => step.id === id);

  test("STACK_STEP_SECRETS gives the three to the cire_seed step and none to the deploy", () => {
    expect(STACK_STEP_SECRETS.musubi.map((entry) => [entry.name, entry.step]).toSorted()).toEqual(
      CIRE_SEED_SECRETS.map((name) => [name, "cire_seed"]),
    );
  });

  test("the cire_seed step runs the derive script before the deploy, holding the three and nothing else", () => {
    const seed = steps[indexOf("cire_seed")];
    expect(indexOf("cire_seed")).toBeGreaterThan(-1);
    expect(indexOf("cire_seed")).toBeLessThan(indexOf("deploy"));
    expect(seed?.run).toBe("bun --no-install musubi/infra/scripts/derive-cire-seed.ts");
    expect(seed?.env).toEqual(
      Object.fromEntries(CIRE_SEED_SECRETS.map((name) => [name, `\${{ secrets.${name} }}`])),
    );
    expect(seed?.if).toBeUndefined();
    expect(seed?.["continue-on-error"]).toBeUndefined();
  });

  test("the deploy step reads none of the three and takes the seed values from the cire_seed step's outputs", () => {
    const deploy = steps[indexOf("deploy")];
    expect(secretsRead(deploy).filter((name) => CIRE_SEED_SECRETS.includes(name))).toEqual([]);
    expect(JSON.stringify(deploy)).not.toMatch(
      /\bCIRE_API_ARC_PRIVATE_KEY\b|\bCIRE_OIDC_CLIENT_SECRET\b/,
    );
    expect({
      CIRE_API_ARC_KEY_ID: deploy?.env?.CIRE_API_ARC_KEY_ID,
      CIRE_API_ARC_PUBLIC_JWK: deploy?.env?.CIRE_API_ARC_PUBLIC_JWK,
      CIRE_OIDC_CLIENT_SECRET_SHA256: deploy?.env?.CIRE_OIDC_CLIENT_SECRET_SHA256,
    }).toEqual({
      CIRE_API_ARC_KEY_ID: "${{ steps.cire_seed.outputs.key_id }}",
      CIRE_API_ARC_PUBLIC_JWK: "${{ steps.cire_seed.outputs.public_jwk }}",
      CIRE_OIDC_CLIENT_SECRET_SHA256: "${{ steps.cire_seed.outputs.client_secret_sha256 }}",
    });
  });

  test("no other step of the musubi job reads the three", () => {
    const readers = steps
      .filter((step) => secretsRead(step).some((name) => CIRE_SEED_SECRETS.includes(name)))
      .map((step) => step.id);
    expect(readers).toEqual(["cire_seed"]);
  });
});

describe("W12: each stack job checks its token before any step uses it", () => {
  test.each(STACK_KEYS.map((key) => [key] as const))(
    "%s: the first step reading the dev token is token:check, on the dev pair alone",
    (key) => {
      const steps = stackJob(key).steps ?? [];
      const first = steps.find((step) =>
        secretsRead(step).includes(TIER_ACCOUNTS.dev.apiTokenSecret),
      );
      expect(first?.id).toBe("token");
      expect(first?.run).toBe("bun run --cwd shared/infra token:check -- --tier dev");
      // The zone check needs the dev domain: a dev token must act on that zone.
      expect(first?.env?.DEV_DOMAIN).toBe("${{ vars.DEV_DOMAIN }}");
      expect(first?.["continue-on-error"]).toBeUndefined();
      expect(first?.if).toBeUndefined();
      expect(secretsRead(first)).toEqual([...accountSecrets("dev")]);
    },
  );
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

describe("each cire site that retargets its CSP builds with the deploy tier hashed", () => {
  // OSN_DEPLOY_TIER tells the shared CSP integration that a build deploys, so
  // it refuses the local cire-api fallback. Strict env mode hides a variable
  // turbo.json does not name from `astro build`, and one it passes through
  // unhashed would let a deploy build replay a cached test build made without
  // it, where the integration never runs. The sites are every workspace that
  // depends on `@cire/build-tools`, the same set scripts/tests/
  // deploy-workflows.test.ts requires each deploy build to set the tier for.
  interface Manifest {
    readonly name: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  }
  const readJson = <T>(path: string) => JSON.parse(readFileSync(`${ROOT}${path}`, "utf8")) as T;
  const SITES = readJson<{ workspaces: string[] }>("package.json")
    .workspaces.flatMap((pattern) =>
      Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })),
    )
    .map((path) => readJson<Manifest>(path))
    .filter((pkg) => "@cire/build-tools" in { ...pkg.dependencies, ...pkg.devDependencies })
    .map((pkg) => pkg.name);

  test("turbo hashes OSN_DEPLOY_TIER into each site's build", () => {
    expect(SITES.length).toBeGreaterThan(0);
    const run = Bun.spawnSync(
      [
        `${ROOT}node_modules/.bin/turbo`,
        "run",
        "build",
        ...SITES.map((site) => `--filter=${site}`),
        "--dry=json",
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OSN_DEPLOY_TIER: "dev",
          DO_NOT_TRACK: "1",
          TURBO_TELEMETRY_DISABLED: "1",
        },
      },
    );
    expect(run.exitCode).toBe(0);
    const dry = JSON.parse(run.stdout.toString()) as { readonly tasks: readonly DryRunTask[] };
    const names = (list: readonly string[] | null) =>
      (list ?? []).map((entry) => entry.split("=")[0]);
    for (const site of SITES) {
      const task = dry.tasks.find((candidate) => candidate.taskId === `${site}#build`);
      expect(names(task?.environmentVariables.configured ?? null)).toContain("OSN_DEPLOY_TIER");
    }
  });
});

describe("PW3: production-release.yml hands each credential only to the steps that use it", () => {
  const PRODUCTION = Bun.YAML.parse(
    readFileSync(`${ROOT}.github/workflows/production-release.yml`, "utf8"),
  ) as Workflow;
  const productionJobs = Object.entries(PRODUCTION.jobs);
  /** The jobs that run Alchemy: the plan job, and each stack's flip verify and deploy. */
  const alchemyJobs = productionJobs.filter(
    ([id]) => id === "alchemy-plan" || /^stack-[a-z]+-(production|verify)$/.test(id),
  );
  const isInstall = (step: Step) => /\bbun install\b/.test(step.run ?? "");

  test("the Pages and DNS token reaches only the pages-domain steps, each before any install in its job", () => {
    const readers = productionJobs.flatMap(([id, job]) =>
      (job.steps ?? []).flatMap((step, at) =>
        secretsRead(step).includes(PAGES_DNS_CREDENTIALS[0] ?? "") ? [{ id, step, at, job }] : [],
      ),
    );
    expect(readers.map(({ id, step }) => `${id} ${step.id}`).toSorted()).toEqual([
      "alchemy-plan domains",
      "flip-detach-cire detach",
      "flip-detach-musubi detach",
    ]);
    for (const { id, step, at, job } of readers) {
      // Every command the step runs is pages-domain.ts.
      const commands = (step.run ?? "").split("\n").filter((line) => line.trim() !== "");
      expect(commands.every((line) => line.startsWith("bun run scripts/pages-domain.ts "))).toBe(
        true,
      );
      const install = (job.steps ?? []).findIndex(isInstall);
      expect({ id, installsBefore: install > -1 && install < at }).toEqual({
        id,
        installsBefore: false,
      });
      // The narrow token travels with the account id alone.
      expect(secretsRead(step)).toEqual(
        ["CLOUDFLARE_ACCOUNT_ID", ...PAGES_DNS_CREDENTIALS].toSorted(),
      );
    }
    // A detach job installs nothing at all, so no dependency's code runs on its runner.
    for (const [id, job] of productionJobs.filter(([name]) => name.startsWith("flip-detach-"))) {
      expect({ id, installs: (job.steps ?? []).some(isInstall) }).toEqual({ id, installs: false });
    }
    for (const [, job] of productionJobs) {
      expect(secretsRead(job.env)).not.toContain(PAGES_DNS_CREDENTIALS[0]);
    }
  });

  test("in the Alchemy jobs, only the token, state, snapshot, plan, deploy, compare and smoke steps hold the production pair, and no job-level env holds a secret", () => {
    expect(alchemyJobs.map(([id]) => id).toSorted()).toEqual([
      "alchemy-plan",
      "stack-cire-production",
      "stack-cire-verify",
      "stack-musubi-production",
      "stack-musubi-verify",
    ]);
    const holds =
      /^(token|state|snapshot(_[a-z]+)?|plan(_[a-z]+)?|deploy|deployments|smoke_[a-z_]+)$/;
    const pair = accountSecrets("production");
    for (const [id, job] of alchemyJobs) {
      expect({ id, env: secretsRead(job.env) }).toEqual({ id, env: [] });
      for (const step of job.steps ?? []) {
        const read = secretsRead(step);
        const expected =
          step.id === "domains"
            ? ["CLOUDFLARE_ACCOUNT_ID", ...PAGES_DNS_CREDENTIALS].toSorted()
            : holds.test(step.id ?? "")
              ? [...pair]
              : [];
        expect({ id, step: step.name ?? step.id, read }).toEqual({
          id,
          step: step.name ?? step.id,
          read: expected,
        });
      }
    }
  });

  test("the plan, build and sites jobs, the comparison and the record jobs read no secret", () => {
    const quiet = productionJobs.filter(
      ([id, job]) =>
        ["plan", "build", "sites", "site-parity"].includes(id) ||
        JSON.stringify(job).includes("production-records"),
    );
    expect(quiet.length).toBeGreaterThan(4);
    for (const [id, job] of quiet) expect({ id, read: secretsRead(job) }).toEqual({ id, read: [] });
  });
});
