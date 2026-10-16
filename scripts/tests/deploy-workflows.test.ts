// Holds .github/workflows/deploy.yml (dev) and production-release.yml
// (production) to the surface map in scripts/deploy-surfaces.ts.
//
// Four things here are load-bearing and invisible to every other gate:
//   - each deploy job gates on its own surface's output. A copy-paste slip
//     that gates one surface on another's output passes actionlint and leaves
//     a surface that never deploys;
//   - each job's name matches the map, because the release planner finds the
//     commit a surface last deployed by the name of the job that deployed it;
//   - every production job needs exactly [plan, build], so they all reach the
//     approval gate together and one review releases them. A job that reached
//     the gate later would need a review of its own;
//   - every Worker deploy is followed by scripts/smoke-check.ts for its own
//     surface and tier, with the job's Cloudflare credentials in reach of its
//     rollback, and that script's target is the Worker the deploy step
//     deployed — the same working directory and wrangler flags.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { surface, SURFACES, type Tier, WORKFLOW_FILE } from "../deploy-surfaces";
import { SMOKE_TARGETS, type WorkerSurface } from "../smoke-check";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, string | number | boolean>;
  readonly env?: Record<string, string>;
  readonly "working-directory"?: string;
  readonly "timeout-minutes"?: number;
  readonly "continue-on-error"?: boolean | string;
}

interface Job {
  readonly name?: string;
  readonly env?: Record<string, string>;
  readonly defaults?: unknown;
  readonly steps?: readonly Step[];
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: string | { readonly name: string };
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress"?: boolean };
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly defaults?: unknown;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Record<string, Job>;
}

const root = join(import.meta.dir, "..", "..");
const load = (path: string) => Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Workflow;
const dev = load(WORKFLOW_FILE.dev);
const production = load(WORKFLOW_FILE.production);

const stepsOf = (job: Job | undefined) => job?.steps ?? [];
const checkoutsOf = (job: Job | undefined) =>
  stepsOf(job).filter((step) => step.uses?.startsWith("actions/checkout@") === true);

const environmentOf = (job: Job) =>
  typeof job.environment === "string" ? job.environment : job.environment?.name;
const needsOf = (job: Job) =>
  typeof job.needs === "string" ? [job.needs] : [...(job.needs ?? [])];
const jobsIn = (workflow: Workflow, environment: string) =>
  Object.entries(workflow.jobs).filter(([, job]) => environmentOf(job) === environment);

describe("deploy.yml deploys dev only", () => {
  test("no job in it reaches the production Environment", () => {
    expect(jobsIn(dev, "production")).toEqual([]);
  });

  test("the changes job outputs exactly the dev surfaces", () => {
    const outputs = dev.jobs.changes?.outputs ?? {};
    const keys = SURFACES.filter((s) => s.dev !== undefined).map((s) => s.key);
    expect(Object.keys(outputs).toSorted()).toEqual(keys.toSorted());
    for (const key of keys) expect(outputs[key]).toBe(`\${{ steps.filter.outputs.${key} }}`);
  });

  test("the changes job diffs the push with the surface map, over full history", () => {
    const changes = dev.jobs.changes;
    expect(checkoutsOf(changes)[0]?.with?.["fetch-depth"]).toBe(0);
    const filter = stepsOf(changes).find((step) => step.id === "filter");
    expect(filter?.run).toBe(
      'bun run scripts/deploy-surfaces.ts --event "$EVENT_NAME" --base "$BEFORE_SHA"',
    );
    expect(filter?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      BEFORE_SHA: "${{ github.event.before }}",
    });
  });

  test("its deploy jobs are the map's dev jobs, no more and no fewer", () => {
    const deploys = Object.keys(dev.jobs).filter((id) => id.startsWith("deploy-"));
    const expected = SURFACES.flatMap((s) => (s.dev ? [s.dev.id] : []));
    expect(deploys.toSorted()).toEqual(expected.toSorted());
  });

  test.each(SURFACES.filter((s) => s.dev !== undefined).map((s) => [s.key, s] as const))(
    "%s: the dev job carries its name, gates on its own output and runs in dev",
    (key, s) => {
      const job = dev.jobs[s.dev!.id];
      expect(job?.name).toBe(s.dev!.name);
      expect(job?.if).toBe(`needs.changes.outputs.${key} == 'true'`);
      expect(environmentOf(job!)).toBe("dev");
      expect(needsOf(job!).toSorted()).toEqual(["build", "changes"]);
    },
  );
});

describe("production-release.yml", () => {
  test("runs on a schedule and by hand, with the two inputs the planner reads", () => {
    expect(Object.keys(production.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
    const dispatch = production.on.workflow_dispatch as {
      inputs: Record<string, { type: string }>;
    };
    expect(dispatch.inputs.surfaces?.type).toBe("string");
    expect(dispatch.inputs.force?.type).toBe("boolean");
  });

  test("one release at a time, never cancelling one in progress", () => {
    expect(production.concurrency?.group).toStartWith("production-release-");
    expect(production.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("the plan job can read deployments and job names, and outputs every surface", () => {
    const plan = production.jobs.plan!;
    expect(plan.permissions).toEqual({ contents: "read", deployments: "read", actions: "read" });
    const outputs = plan.outputs ?? {};
    expect(Object.keys(outputs).toSorted()).toEqual(
      [...SURFACES.map((s) => s.key), "any"].toSorted(),
    );
    for (const key of Object.keys(outputs))
      expect(outputs[key]).toBe(`\${{ steps.plan.outputs.${key} }}`);
  });

  test("the plan job refuses any ref but main before it does anything else", () => {
    const [guard] = stepsOf(production.jobs.plan);
    expect(guard?.if).toBe("github.ref != 'refs/heads/main'");
    expect(guard?.run).toContain("exit 1");
  });

  test("the plan job runs the planner over full history, with the token and both inputs", () => {
    const plan = production.jobs.plan;
    expect(checkoutsOf(plan)[0]?.with?.["fetch-depth"]).toBe(0);
    const step = stepsOf(plan).find((s) => s.id === "plan");
    expect(step?.run).toBe("bun run scripts/release-plan.ts");
    expect(step?.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      SURFACES: "${{ inputs.surfaces }}",
      FORCE: "${{ inputs.force }}",
    });
  });

  test("no checkout leaves the job token on disk", () => {
    const checkouts = Object.values(production.jobs).flatMap((job) => checkoutsOf(job));
    expect(checkouts.length).toBe(Object.keys(production.jobs).length);
    for (const checkout of checkouts) expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  test("the surfaces input lists exactly the map's keys", () => {
    const dispatch = production.on.workflow_dispatch as {
      inputs: Record<string, { description: string }>;
    };
    const listed = /: ([a-z_ ]+)\. Empty means all\./.exec(
      dispatch.inputs.surfaces?.description ?? "",
    );
    expect(listed?.[1]?.split(" ")).toEqual(SURFACES.map((s) => s.key));
  });

  test("build runs only when something ships", () => {
    const build = production.jobs.build!;
    expect(needsOf(build)).toEqual(["plan"]);
    expect(build.if).toBe("needs.plan.outputs.any == 'true'");
  });

  test("its production jobs are the map's, no more and no fewer", () => {
    const ids = jobsIn(production, "production").map(([id]) => id);
    expect(ids.toSorted()).toEqual(SURFACES.map((s) => s.production.id).toSorted());
  });

  test.each(SURFACES.map((s) => [s.key, s] as const))(
    "%s: named as the map says, gated on its own output, released by the one approval",
    (key, s) => {
      const job = production.jobs[s.production.id]!;
      expect(job.name).toBe(s.production.name);
      expect(job.if).toBe(`needs.plan.outputs.${key} == 'true'`);
      expect(environmentOf(job)).toBe("production");
      expect(needsOf(job).toSorted()).toEqual(["build", "plan"]);
      expect(job.concurrency).toEqual({
        group: `deploy-production-${s.production.id.slice("deploy-".length)}`,
        "cancel-in-progress": false,
      });
    },
  );
});

describe("every Worker deploy is smoke-checked, and rolls back the Worker it deployed", () => {
  const SMOKE_STEP = "Smoke check, rolling back on failure";
  const workflowOf = (tier: Tier) => (tier === "production" ? production : dev);
  const jobIdOf = (key: WorkerSurface, tier: Tier) => {
    const job = tier === "production" ? surface(key).production : surface(key).dev;
    if (job === undefined) throw new Error(`${key} has no ${tier} job`);
    return job.id;
  };
  const targets = Object.entries(SMOKE_TARGETS).flatMap(([key, tiers]) =>
    Object.entries(tiers).map(
      ([tier, target]) => [`${key} ${tier}`, key as WorkerSurface, tier as Tier, target] as const,
    ),
  );

  test("the jobs that run `wrangler deploy` are exactly the smoke targets' jobs", () => {
    const deploying = (tier: Tier) =>
      Object.entries(workflowOf(tier).jobs)
        .filter(([, job]) => stepsOf(job).some((s) => /\bwrangler deploy\b/.test(s.run ?? "")))
        .map(([id]) => `${tier} ${id}`);
    const expected = targets.map(([, key, tier]) => `${tier} ${jobIdOf(key, tier)}`);
    expect([...deploying("dev"), ...deploying("production")].toSorted()).toEqual(
      expected.toSorted(),
    );
  });

  test.each(targets)("%s", (_, key, tier, target) => {
    const job = workflowOf(tier).jobs[jobIdOf(key, tier)]!;
    expect(environmentOf(job)).toBe(tier);
    const steps = stepsOf(job);
    const deployAt = steps.findIndex((s) => /\bwrangler deploy\b/.test(s.run ?? ""));
    const deploy = steps[deployAt]!;
    // The rollback reads the same flags in the same directory, so it finds
    // the same Worker the deploy step deployed.
    expect(deploy.run).toBe(`bunx wrangler deploy ${target.wrangler.join(" ")}`);
    expect(deploy["working-directory"]).toBe(target.cwd);
    // The deploy step writes the version it deployed where the check reads
    // it; the check rolls back only while that version is the newest.
    const output = "${{ runner.temp }}/wrangler-deploy.ndjson";
    expect(deploy.env).toEqual({ WRANGLER_OUTPUT_FILE_PATH: output });

    const smoke = steps[deployAt + 1];
    expect(smoke?.name).toBe(SMOKE_STEP);
    expect(smoke?.run).toBe(`bun run scripts/smoke-check.ts ${key} ${tier}`);
    expect(smoke?.["working-directory"]).toBeUndefined();
    expect(smoke?.if).toBe(deploy.if);
    expect(smoke?.["timeout-minutes"]).toBe(5);
    // The job's failure is what marks its Deployment record `failure`.
    expect(smoke?.["continue-on-error"]).toBeUndefined();
    expect(steps.length).toBe(deployAt + 2);

    // The rollback reads the job's credentials. A token moved into the deploy
    // step's own env would keep every deploy working and fail every rollback.
    expect(job.env?.CLOUDFLARE_API_TOKEN).toMatch(/^\$\{\{ secrets\.CLOUDFLARE_API_TOKEN/);
    expect(job.env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    for (const step of [deploy, smoke]) {
      expect(Object.keys(step?.env ?? {}).filter((name) => name.startsWith("CLOUDFLARE_"))).toEqual(
        [],
      );
    }
    // `bun run scripts/smoke-check.ts` resolves from the repository root.
    expect(job.defaults).toBeUndefined();
    expect(workflowOf(tier).defaults).toBeUndefined();

    const env = smoke?.env ?? {};
    expect(env.WRANGLER_OUTPUT_FILE_PATH).toBe(output);
    if (tier === "dev") expect(env.SMOKE_FORCE_FAIL).toBe(`\${{ inputs.smoke_fail == '${key}' }}`);
    else expect(env.SMOKE_FORCE_FAIL).toBeUndefined();
    if (target.access) {
      expect(env.CF_ACCESS_CLIENT_ID).toBe("${{ secrets.CF_ACCESS_CLIENT_ID }}");
      expect(env.CF_ACCESS_CLIENT_SECRET).toBe("${{ secrets.CF_ACCESS_CLIENT_SECRET }}");
    } else {
      expect(Object.keys(env).filter((name) => name.startsWith("CF_ACCESS"))).toEqual([]);
    }
  });

  test("deploy.yml's dispatch can force one dev Worker's check to fail", () => {
    const dispatch = dev.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default: string; options: string[] }>;
    };
    const input = dispatch.inputs.smoke_fail;
    expect(input?.type).toBe("choice");
    expect(input?.default).toBe("none");
    const devWorkers = targets.filter(([, , tier]) => tier === "dev").map(([, key]) => key);
    expect(input?.options).toEqual(["none", ...devWorkers]);
  });

  test("production can never be forced to fail", () => {
    const text = readFileSync(join(root, WORKFLOW_FILE.production), "utf8");
    expect(text).not.toContain("SMOKE_FORCE_FAIL");
    expect(text).not.toContain("smoke_fail");
  });
});

describe("installs", () => {
  test.each([WORKFLOW_FILE.dev, WORKFLOW_FILE.production])(
    "%s installs from the lockfile and never rewrites it",
    (path) => {
      const installs = Object.values(load(path).jobs)
        .flatMap((job) => stepsOf(job))
        .filter((step) => /^bun install\b/.test(step.run ?? ""));
      expect(installs.length).toBeGreaterThan(0);
      for (const step of installs) expect(step.run).toBe("bun install --frozen-lockfile");
    },
  );
});

describe("every other workflow", () => {
  const otherWorkflows = () => {
    const owners = new Set<string>([WORKFLOW_FILE.dev, WORKFLOW_FILE.production]);
    return readdirSync(join(root, ".github/workflows"))
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .map((file) => `.github/workflows/${file}`)
      .filter((path) => !owners.has(path));
  };

  // The planner ties a Deployment record to a surface by its job's name, and
  // counts only records from runs of the two deploy workflows. A job of the
  // same name anywhere else is a deploy the planner cannot see.
  // A Worker deployed from anywhere else skips the smoke check, and the planner
  // never sees it.
  test("deploys no Worker", () => {
    for (const path of otherWorkflows()) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).not.toMatch(/\bwrangler (versions )?deploy\b|cloudflare\/wrangler-action/);
    }
  });

  test("uses none of the map's job names", () => {
    const names = new Set(
      SURFACES.flatMap((s) => (s.dev ? [s.production.name, s.dev.name] : [s.production.name])),
    );
    const others = otherWorkflows();
    expect(others.length).toBeGreaterThan(0);
    for (const path of others) {
      const jobs = Object.values(load(path).jobs ?? {});
      for (const job of jobs) expect(names.has(job.name ?? "")).toBe(false);
    }
  });
});
