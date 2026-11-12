// Holds .github/workflows/deploy.yml (dev) and production-release.yml
// (production) to the surface map in scripts/deploy-surfaces.ts.
//
// What is load-bearing here and invisible to every other gate:
//   - each job's name matches the map, because the release planner finds the
//     commit a surface last deployed by the name of the job that deployed it;
//     on dev that is the record job, which runs only when its stack job
//     deployed and its surface's smoke check passed;
//   - each production job gates on its own surface's output, and each dev
//     stack job on its own stack's. A copy-paste slip that gates one on
//     another's output passes actionlint and leaves something that never
//     deploys;
//   - every production job needs exactly [plan, build], so they all reach the
//     approval gate together and one review releases them;
//   - every Worker deploy is followed by scripts/smoke-check.ts for its own
//     surface and tier, with credentials in reach of its rollback: on
//     production the step after `wrangler deploy`, pinned to the version the
//     deploy wrote; on dev one step per surface of the stack, pinned to the
//     deployment scripts/worker-deployments.ts found;
//   - every dev host a dev build or check reads comes from the stack job's
//     dev-hosts step, never a literal.
// shared/infra/tests/workflow-secrets.test.ts holds which secrets each dev
// step reads, and shared/infra/tests/workflow-hosts.test.ts that every host
// output read is one the dev-hosts step writes.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SITE_BUILDS, type SiteSurface } from "../../shared/infra/src/production-sites";
import {
  PRODUCTION_STACKS,
  PRODUCTION_SURFACES,
  stack,
  stackDeployed,
  type StackKey,
  STACKS,
  type Surface,
  type SurfaceKey,
  SURFACES,
  WORKFLOW_FILE,
} from "../deploy-surfaces";
import { SITE_DIRECTORIES } from "../production-sites-artifact";
import { devDeployStep, MAX_RECORDS } from "../release-plan";
import {
  devTarget,
  type Probe,
  productionSiteTarget,
  productionTarget,
  SMOKE_TARGETS,
} from "../smoke-check";

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
  readonly concurrency?: {
    readonly group: string;
    readonly "cancel-in-progress"?: boolean | string;
    readonly queue?: "single" | "max";
  };
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly "timeout-minutes"?: number;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: { readonly include?: readonly Record<string, string | number>[] };
  };
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string | boolean>;
  readonly defaults?: unknown;
  readonly concurrency?: {
    readonly group: string;
    readonly "cancel-in-progress"?: boolean | string;
  };
  readonly jobs: Record<string, Job>;
}

const root = join(import.meta.dir, "..", "..");
const load = (path: string) => Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Workflow;
const dev = load(WORKFLOW_FILE.dev);
const production = load(WORKFLOW_FILE.production);

interface CompositeAction {
  readonly runs: { readonly using: string; readonly steps?: readonly Step[] };
}

/**
 * A job's steps, each step that uses a local composite action
 * (`uses: ./.github/actions/<name>`) replaced by that action's own steps, so a
 * check on a job's caches, installs or saves also reads what the job runs
 * through the action.
 */
const stepsOf = (job: Job | undefined): readonly Step[] =>
  (job?.steps ?? []).flatMap((step) => {
    if (!step.uses?.startsWith("./")) return [step];
    const action = Bun.YAML.parse(
      readFileSync(join(root, step.uses, "action.yml"), "utf8"),
    ) as CompositeAction;
    if (action.runs.using !== "composite") {
      throw new Error(`${step.uses} is not a composite action`);
    }
    return action.runs.steps ?? [];
  });
const checkoutsOf = (job: Job | undefined) =>
  stepsOf(job).filter((step) => step.uses?.startsWith("actions/checkout@") === true);

const environmentOf = (job: Job) =>
  typeof job.environment === "string" ? job.environment : job.environment?.name;
const needsOf = (job: Job) =>
  typeof job.needs === "string" ? [job.needs] : [...(job.needs ?? [])];
const jobsIn = (workflow: Workflow, environment: string) =>
  Object.entries(workflow.jobs).filter(([, job]) => environmentOf(job) === environment);

// ── dev: the stacks ─────────────────────────────────────────────────────────

const surfacesOf = (key: StackKey): readonly Surface[] => SURFACES.filter((s) => s.stack === key);
const stackJobOf = (key: StackKey): Job => {
  const job = dev.jobs[stack(key).job.id];
  if (job === undefined) throw new Error(`deploy.yml has no ${stack(key).job.id} job`);
  return job;
};
const stepIndex = (job: Job, id: string) => stepsOf(job).findIndex((step) => step.id === id);
const stepById = (job: Job, id: string) => stepsOf(job).find((step) => step.id === id);
/** "Deploy osn/api — dev" → "osn/api". */
const displayName = (s: Surface) => s.dev.name.replace(/^Deploy (.+) — dev$/, "$1");

const hostOutput = (key: string) => `\${{ steps.hosts.outputs.${key} }}`;
const DEV_CREDENTIALS = {
  CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}",
  CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}",
} as const;
const ON_SNAPSHOT = "${{ !cancelled() && steps.snapshot.outcome == 'success' }}";
/** A step that runs only when the order check let this commit deploy (and every step before it passed). */
const ON_ORDER = "${{ steps.order.outputs.deploy == 'true' }}";

/** The dev-hosts output naming each surface's dev origin. */
const DEV_HOST_OUTPUT: Readonly<Record<SurfaceKey, string>> = {
  cire_api: "cire_api_origin",
  cire_invites: "cire_invites_origin",
  cire_host: "cire_host_origin",
  cire_vendor: "cire_vendor_origin",
  cire_landing: "cire_landing_origin",
  osn_api: "osn_api_origin",
  osn_social: "musubi_social_origin",
  musubi_landing: "musubi_landing_origin",
  zap_api: "zap_api_origin",
  pulse_landing: "pulse_landing_origin",
};

/**
 * Each stack job's site builds, in order, with exactly the values each dev
 * build sets. A host is always the dev-hosts step's output; Turnstile and Maps
 * keys are dev Environment variables; the guest and marketing sites' footers
 * and the portals' account menus print the commit (PUBLIC_BUILD_SHA); ASTRO_KEY fixes the guest site's server build so
 * two builds of one commit are byte-identical; OSN_DEPLOY_TIER marks each
 * build of a site that retargets its CSP as a deploy. Pulse landing gets no
 * PUBLIC_APP_URL: the Pulse app has no dev deploy.
 */
const DEV_BUILDS: Readonly<
  Record<StackKey, readonly { readonly pkg: string; readonly env: Record<string, string> }[]>
> = {
  musubi: [
    {
      pkg: "@musubi/social",
      env: {
        VITE_OSN_ISSUER_URL: hostOutput("osn_api_origin"),
        VITE_TURNSTILE_SITEKEY: "${{ vars.PUBLIC_TURNSTILE_SITEKEY }}",
      },
    },
    {
      pkg: "@musubi/landing",
      env: {
        SITE: hostOutput("musubi_landing_origin"),
        PUBLIC_APP_URL: hostOutput("musubi_social_origin"),
      },
    },
  ],
  cire: [
    {
      pkg: "@cire/invites",
      env: {
        PUBLIC_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_SITE_URL: hostOutput("cire_invites_origin"),
        PUBLIC_MARKETING_URL: hostOutput("cire_landing_origin"),
        PUBLIC_TURNSTILE_SITEKEY: "${{ vars.PUBLIC_TURNSTILE_SITEKEY }}",
        PUBLIC_GOOGLE_MAPS_EMBED_KEY: "${{ vars.PUBLIC_GOOGLE_MAPS_EMBED_KEY }}",
        PUBLIC_BUILD_SHA: "${{ github.sha }}",
        ASTRO_KEY: "${{ secrets.ASTRO_KEY }}",
        OSN_DEPLOY_TIER: "dev",
      },
    },
    {
      pkg: "@cire/host",
      env: {
        PUBLIC_CIRE_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_OSN_ACCOUNT_URL: hostOutput("musubi_social_origin"),
        PUBLIC_CIRE_WEB_URL: hostOutput("cire_invites_origin"),
        PUBLIC_MARKETING_URL: hostOutput("cire_landing_origin"),
        PUBLIC_BUILD_SHA: "${{ github.sha }}",
        OSN_DEPLOY_TIER: "dev",
      },
    },
    {
      pkg: "@cire/vendor",
      env: {
        PUBLIC_CIRE_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_OSN_ACCOUNT_URL: hostOutput("musubi_social_origin"),
        PUBLIC_BUILD_SHA: "${{ github.sha }}",
        OSN_DEPLOY_TIER: "dev",
      },
    },
    {
      pkg: "@cire/landing",
      env: {
        PUBLIC_ORGANISER_URL: hostOutput("cire_host_origin"),
        SITE: hostOutput("cire_landing_origin"),
        PUBLIC_BUILD_SHA: "${{ github.sha }}",
      },
    },
  ],
  zap: [],
  pulse: [{ pkg: "@pulse/landing", env: { SITE: hostOutput("pulse_landing_origin") } }],
};

/**
 * The dev Environment variables each stack's deploy step passes to Alchemy.
 * The cire stack seeds the owner seat from CIRE_DEV_OWNER_PROFILE_ID
 * (cire/infra/alchemy.run.ts); missing or misspelt here, GitHub passes
 * nothing and the stack seeds no owner seat, with every gate green.
 */
const DEPLOY_VARIABLES: Readonly<Record<StackKey, Record<string, string>>> = {
  musubi: { DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" },
  cire: {
    DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}",
    CIRE_DEV_OWNER_PROFILE_ID: "${{ vars.CIRE_DEV_OWNER_PROFILE_ID }}",
  },
  zap: { DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" },
  pulse: { DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" },
};

/** The bundle-size guards each stack job runs on its builds before anything uploads. */
const BUNDLE_GUARDS: Readonly<Record<StackKey, readonly string[]>> = {
  musubi: ["musubi/landing"],
  cire: ["cire/invites", "cire/host", "cire/vendor", "cire/landing"],
  zap: [],
  pulse: ["pulse/landing"],
};

/** The checks a stack job runs besides its smoke checks, by step id. */
const EXTRA_CHECKS: Partial<Record<StackKey, readonly string[]>> = {
  cire: ["parity_cire_invites"],
};

const BUILD = /\bbun run build --filter=(\S+)/;
const buildsOf = (job: Job) => stepsOf(job).filter((step) => BUILD.test(step.run ?? ""));

interface ShellRun {
  readonly exitCode: number;
  readonly output: string;
  /** One line per `bun` invocation: its arguments. */
  readonly bunCalls: readonly string[];
}

/** What the stand-in `bun` prints on stdout and stderr, as Alchemy's output would be. */
const BUN_OUTPUT = "stand-in-bun-output";

/**
 * Runs a step's `run` script as GitHub runs one with no `shell:` (`bash -e`),
 * with a stand-in `bun` on PATH that records its arguments, prints
 * BUN_OUTPUT to stdout and stderr, and exits with `bunExit`.
 */
function runStep(step: Step, env: Readonly<Record<string, string>>, bunExit = 0): ShellRun {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-step-"));
  const log = join(dir, "bun-calls");
  const bun = join(dir, "bun");
  writeFileSync(
    bun,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho ${BUN_OUTPUT}\necho ${BUN_OUTPUT} >&2\nexit ${bunExit}\n`,
  );
  chmodSync(bun, 0o755);
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", step.run ?? ""], {
    cwd: dir,
    env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, ...env },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    bunCalls: existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "")
      : [],
  };
}

describe("deploy.yml deploys dev only", () => {
  test("runs on a push to main and by hand", () => {
    expect(Object.keys(dev.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
    expect((dev.on.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  test("no job in it reaches the production Environment", () => {
    expect(jobsIn(dev, "production")).toEqual([]);
  });

  test("it can only read: the repository, and in the stack jobs alone the deployments and Actions runs the order check reads; every Alchemy run in it sends no telemetry", () => {
    expect(dev.permissions).toEqual({ contents: "read" });
    // A job-level block replaces the workflow's for that job.
    const own = Object.entries(dev.jobs).filter(([, job]) => job.permissions !== undefined);
    expect(own.map(([id]) => id)).toEqual(STACKS.map((s) => s.job.id));
    for (const [, job] of own) {
      expect(job.permissions).toEqual({ contents: "read", deployments: "read", actions: "read" });
    }
    expect(dev.env?.DO_NOT_TRACK).toBe("1");
  });

  test("its jobs are changes, build, the stack jobs and the record jobs, nothing else", () => {
    expect(Object.keys(dev.jobs).toSorted()).toEqual(
      [
        "changes",
        "build",
        ...STACKS.map((s) => s.job.id),
        ...SURFACES.map((s) => s.dev.id),
      ].toSorted(),
    );
  });

  test("the changes job outputs every dev surface and every stack", () => {
    const outputs = dev.jobs.changes?.outputs ?? {};
    const keys = [...SURFACES.map((s) => s.key), ...STACKS.map((s) => `stack_${s.key}`)];
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

  test("dispatch offers force and expect_no_change, both off by default", () => {
    const dispatch = dev.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default: boolean }>;
    };
    for (const name of ["force", "expect_no_change"]) {
      expect(dispatch.inputs[name]?.type).toBe("boolean");
      expect(dispatch.inputs[name]?.default).toBe(false);
    }
  });

  test("W5: no step names wrangler; Wrangler runs only as the guest route comparison's local runtime, in a step holding no Cloudflare credential", () => {
    expect(readFileSync(join(root, WORKFLOW_FILE.dev), "utf8")).not.toMatch(/wrangler/i);
    // scripts/guest-route-parity.ts starts Wrangler's local runtime, through
    // its Node child, with an environment of its own (referenceEnv); the step
    // that runs it holds no credential to hand on in the first place.
    const parity = Object.values(dev.jobs)
      .flatMap((job) => stepsOf(job))
      .filter((step) => (step.run ?? "").includes("guest-route-parity"));
    expect(parity.map((step) => step.id)).toEqual(["parity_cire_invites"]);
    for (const step of parity) {
      expect(Object.keys(step.env ?? {}).filter((name) => name.startsWith("CLOUDFLARE_"))).toEqual(
        [],
      );
    }
  });

  test("W4: no URL is written into it; every value that names a dev host comes from a step", () => {
    const stepValues = (step: Step) => [step.run ?? ""].concat(Object.values(step.env ?? {}));
    const jobValues = (job: Job) =>
      Object.values(job.env ?? {})
        .concat(Object.values(job.outputs ?? {}))
        .concat(stepsOf(job).flatMap(stepValues));
    const values = Object.values(dev.env ?? {})
      .map(String)
      .concat(Object.values(dev.jobs).flatMap(jobValues));
    expect(values.filter((value) => value.includes("://"))).toEqual([]);
  });
});

describe("W1: one Alchemy job per stack", () => {
  test("the stack jobs are the map's stacks, in its order", () => {
    const ids = Object.keys(dev.jobs).filter((id) => id.startsWith("stack-"));
    expect(ids).toEqual(STACKS.map((s) => s.job.id));
  });

  test.each(STACKS.map((s) => [s.key, s] as const))(
    "%s: named as the map says, gated on its own stack output, in dev, alone in its group",
    (key, s) => {
      const job = stackJobOf(key);
      expect(job.name).toBe(s.job.name);
      expect(job.if).toBe(`needs.changes.outputs.stack_${key} == 'true'`);
      expect(environmentOf(job)).toBe("dev");
      // No stack job waits for another: each deploys its whole stack.
      expect(needsOf(job).toSorted()).toEqual(["build", "changes"]);
      // One run at a time per stack, and a run is never cancelled part-way, so
      // no rollback races the next run's deploy. `queue: max` keeps up to 100
      // waiting runs: with GitHub's default, a run joining the group cancels
      // the one already waiting, whose commit may be the newest.
      expect(job.concurrency).toEqual({
        group: `deploy-dev-${key}`,
        "cancel-in-progress": false,
        queue: "max",
      });
      // `bun run scripts/…` resolves from the repository root.
      expect(job.defaults).toBeUndefined();
    },
  );
});

describe("each stack job builds, deploys and checks its whole stack", () => {
  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: the dev-hosts step comes before every build",
    (key) => {
      const job = stackJobOf(key);
      const hosts = stepById(job, "hosts");
      expect(hosts?.run).toBe("bun run --cwd shared/infra dev-hosts -- --stage dev");
      expect(hosts?.env).toEqual({ DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" });
      const install = stepsOf(job).findIndex(
        (step) => step.run === "bun install --frozen-lockfile",
      );
      expect(install).toBeGreaterThan(-1);
      expect(stepIndex(job, "hosts")).toBeGreaterThan(install);
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: builds exactly its sites, every dev host from the dev-hosts step, guarded before anything uploads",
    (key) => {
      const job = stackJobOf(key);
      const builds = buildsOf(job);
      expect(builds.map((step) => BUILD.exec(step.run ?? "")?.[1])).toEqual(
        DEV_BUILDS[key].map((b) => b.pkg),
      );
      for (const [i, build] of builds.entries()) {
        expect(build.env).toEqual(DEV_BUILDS[key][i]!.env);
        expect(build["working-directory"]).toBeUndefined();
      }
      const steps = stepsOf(job);
      const guards = steps
        .map((step, at) => ({
          at,
          target: /^\.\/scripts\/guard-bundle-size\.sh (\S+)$/.exec(step.run ?? "")?.[1],
        }))
        .filter((guard) => guard.target !== undefined);
      expect(guards.map((guard) => guard.target)).toEqual([...BUNDLE_GUARDS[key]]);
      const snapshot = stepIndex(job, "snapshot");
      const lastBuild = Math.max(-1, ...builds.map((build) => steps.indexOf(build)));
      for (const build of builds)
        expect(steps.indexOf(build)).toBeGreaterThan(stepIndex(job, "hosts"));
      for (const guard of guards) {
        expect(guard.at).toBeGreaterThan(lastBuild);
        expect(guard.at).toBeLessThan(snapshot);
      }
      expect(lastBuild).toBeLessThan(snapshot);
    },
  );

  // turbo hashes each dev build's PUBLIC_*, VITE_* and SITE values, so the
  // build job's cache never holds a dev build: an unchanged site replays only
  // from a cache its own stack job saved.
  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: saves a turbo cache of its own, restored before its first build",
    (key) => {
      const job = stackJobOf(key);
      const steps = stepsOf(job);
      const turbo = steps.filter((step) => step.with?.path === ".turbo");
      if (DEV_BUILDS[key].length === 0) {
        expect(turbo).toEqual([]);
        return;
      }
      expect(turbo).toHaveLength(1);
      const [cache] = turbo;
      const lock = "${{ hashFiles('bun.lock') }}";
      expect(cache?.uses).toBe("actions/cache@v4");
      expect(cache?.with).toEqual({
        path: ".turbo",
        key: `\${{ runner.os }}-turbo-dev-${key}-${lock}-\${{ github.sha }}`,
        "restore-keys": [
          `\${{ runner.os }}-turbo-dev-${key}-${lock}-`,
          `\${{ runner.os }}-turbo-dev-${key}-`,
          "",
        ].join("\n"),
      });
      const firstBuild = Math.min(...buildsOf(job).map((build) => steps.indexOf(build)));
      expect(steps.indexOf(cache!)).toBeLessThan(firstBuild);
    },
  );

  // A value turbo does not hash would let a cache hit replay a site built for
  // other hosts; strict env mode hides any value it is not told about.
  test("turbo hashes every value a dev build sets, bar ASTRO_KEY, which it passes through unhashed", () => {
    const build = (
      Bun.JSONC.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
        tasks: { build: { env?: string[]; passThroughEnv?: string[] } };
      }
    ).tasks.build;
    const hashed = (build.env ?? []).map((pattern) => new Bun.Glob(pattern));
    const isHashed = (name: string) => hashed.some((glob) => glob.match(name));
    const names = STACKS.flatMap((s) => buildsOf(stackJobOf(s.key))).flatMap((step) =>
      Object.keys(step.env ?? {}),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name !== "ASTRO_KEY" && !isHashed(name))).toEqual([]);
    expect(build.passThroughEnv).toContain("ASTRO_KEY");
    expect(isHashed("ASTRO_KEY")).toBe(false);
  });

  test("the guest site's build refuses to run without ASTRO_KEY, naming it", () => {
    const build = buildsOf(stackJobOf("cire")).find((step) =>
      step.run?.includes("--filter=@cire/invites"),
    )!;
    const refused = runStep(build, { ASTRO_KEY: "" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.output).toContain("ASTRO_KEY");
    expect(refused.bunCalls).toEqual([]);
    const built = runStep(build, { ASTRO_KEY: "a-fixed-key" });
    expect(built.exitCode).toBe(0);
    expect(built.bunCalls).toEqual(["run build --filter=@cire/invites --cache=local:,remote:"]);
  });

  // Astro writes ASTRO_KEY into the guest site's server output. A build that
  // reads a secret must neither replay a cached build (made with another
  // key, since turbo passes ASTRO_KEY through unhashed) nor leave its output
  // in .turbo, which the stack job saves to a cache other runs can restore.
  test("a build step that reads a secret runs with turbo's cache off", () => {
    const reading = STACKS.flatMap((s) => buildsOf(stackJobOf(s.key))).filter((step) =>
      JSON.stringify(step.env ?? {}).includes("secrets."),
    );
    expect(reading.map((step) => BUILD.exec(step.run ?? "")?.[1])).toEqual(["@cire/invites"]);
    for (const step of reading) {
      const calls = runStep(step, { ASTRO_KEY: "a-fixed-key" }).bunCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEndWith(" --cache=local:,remote:");
    }
  });

  test("no cache key or restore key in any workflow is made from a secret", () => {
    const keys = readdirSync(join(root, ".github/workflows"))
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => Object.values(load(`.github/workflows/${file}`).jobs))
      .flatMap((job) => stepsOf(job))
      .filter((step) => /^actions\/cache(\/(restore|save))?@/.test(step.uses ?? ""))
      .map((step) => `${step.with?.key ?? ""}\n${step.with?.["restore-keys"] ?? ""}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.includes("secrets."))).toEqual([]);
  });

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: snapshot, deploy, plan summary, compare, one check per surface, then the verdict, in that order",
    (key) => {
      const job = stackJobOf(key);
      const surfaces = surfacesOf(key)
        .map((s) => s.key)
        .join(" ");
      const snapshot = stepById(job, "snapshot");
      expect(snapshot?.run).toBe(
        `bun run scripts/worker-deployments.ts snapshot "$RUNNER_TEMP/deployments.json" ${surfaces}`,
      );
      expect(snapshot?.env).toEqual(DEV_CREDENTIALS);
      expect(snapshot?.if).toBe(ON_ORDER);

      const deploy = stepById(job, "deploy");
      // The release planner counts a dev stack job's record only when the
      // step of this name succeeded.
      expect(deploy?.name).toBe(devDeployStep(key));
      expect(deploy?.["working-directory"]).toBe(`${key}/infra`);
      expect(deploy?.if).toBe(ON_ORDER);
      expect(deploy?.["continue-on-error"]).toBeUndefined();
      expect(deploy?.env?.FORCE).toBe(
        "${{ (inputs.force == true || steps.snapshot.outputs.force == 'true') && 'yes' || '' }}",
      );
      expect(deploy?.env?.DO_NOT_TRACK).toBe("1");
      expect(deploy?.env?.OSN_DEPLOY_TIER).toBe("dev");
      expect(deploy?.env?.DEV_DOMAIN).toBe("${{ vars.DEV_DOMAIN }}");
      expect(deploy?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(DEV_CREDENTIALS.CLOUDFLARE_ACCOUNT_ID);
      expect(deploy?.env?.CLOUDFLARE_API_TOKEN).toBe(DEV_CREDENTIALS.CLOUDFLARE_API_TOKEN);

      const summary = stepsOf(job).find((step) => step.run?.includes("plan-summary") === true);
      expect(summary?.if).toBe("${{ !cancelled() && steps.deploy.outcome != 'skipped' }}");
      expect(summary?.env).toEqual({
        EXPECT_NO_CHANGE: "${{ inputs.expect_no_change == true && 'yes' || '' }}",
      });

      const compare = stepById(job, "deployments");
      expect(compare?.run).toBe(
        `bun run scripts/worker-deployments.ts compare "$RUNNER_TEMP/deployments.json" ${surfaces}`,
      );
      expect(compare?.env).toEqual(DEV_CREDENTIALS);
      expect(compare?.if).toBe(ON_SNAPSHOT);
      expect(compare?.["continue-on-error"]).toBe(true);

      const smokes = surfacesOf(key).map((s) => stepIndex(job, `smoke_${s.key}`));
      const steps = stepsOf(job);
      const order = [
        stepIndex(job, "snapshot"),
        stepIndex(job, "deploy"),
        summary === undefined ? -1 : steps.indexOf(summary),
        stepIndex(job, "deployments"),
        ...smokes,
        steps.length - 1,
      ];
      expect(order.every((at) => at > -1)).toBe(true);
      expect(order).toEqual(order.toSorted((a, b) => a - b));
      expect(new Set(order).size).toBe(order.length);
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: the deploy step passes exactly its stack's dev Environment variables",
    (key) => {
      const env = stepById(stackJobOf(key), "deploy")?.env ?? {};
      const variables = Object.fromEntries(
        Object.entries(env).filter(([, value]) => value.includes("vars.")),
      );
      expect(variables).toEqual(DEPLOY_VARIABLES[key]);
      expect(Object.hasOwn(env, "CIRE_DEV_OWNER_PROFILE_ID")).toBe(key === "cire");
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: the deploy reaches Alchemy with --force only when asked, and fails when Alchemy fails",
    (key) => {
      const deploy = stepById(stackJobOf(key), "deploy")!;
      expect(runStep(deploy, { FORCE: "" }).bunCalls).toEqual(["run deploy:dev"]);
      expect(runStep(deploy, { FORCE: "yes" }).bunCalls).toEqual(["run deploy:dev --force"]);
      // The log is piped to a file for the plan summary; the pipe must not
      // hide Alchemy's exit code.
      expect(runStep(deploy, { FORCE: "" }, 3).exitCode).not.toBe(0);
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: the plan summary names its own stack, and expects no change only when asked",
    (key) => {
      const summary = stepsOf(stackJobOf(key)).find((step) => step.run?.includes("plan-summary"))!;
      const log = "/alchemy.log";
      const plain = runStep(summary, { EXPECT_NO_CHANGE: "" }).bunCalls;
      expect(plain).toHaveLength(1);
      expect(plain[0]).toStartWith(`run --cwd shared/infra plan-summary -- --stack ${key} `);
      expect(plain[0]).toEndWith(log);
      expect(runStep(summary, { EXPECT_NO_CHANGE: "yes" }).bunCalls[0]).toContain(
        `--stack ${key} --expect-no-change `,
      );
    },
  );

  test.each(STACKS.map((s) => [s.key, s] as const))(
    "%s: W9 the last step fails the job when the compare or any check failed",
    (key) => {
      const job = stackJobOf(key);
      const last = stepsOf(job).at(-1);
      const failed = [
        "steps.deployments.outcome == 'failure'",
        ...surfacesOf(key).map((s) => `steps.smoke_${s.key}.outcome == 'failure'`),
        ...(EXTRA_CHECKS[key] ?? []).map((id) => `steps.${id}.outcome == 'failure'`),
      ];
      expect(last?.if).toBe(`\${{ !cancelled() && (${failed.join(" || ")}) }}`);
      expect(last?.run).toContain("exit 1");
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: W10 force with expect_no_change is refused first, and expect_no_change while a rollback awaits re-upload",
    (key) => {
      const job = stackJobOf(key);
      const [first] = stepsOf(job);
      expect(first?.if).toBe("${{ inputs.force == true && inputs.expect_no_change == true }}");
      expect(first?.run).toContain("exit 1");
      const steps = stepsOf(job);
      const healing = steps.findIndex(
        (step) =>
          step.if ===
          "${{ inputs.expect_no_change == true && steps.snapshot.outputs.force == 'true' }}",
      );
      expect(healing).toBeGreaterThan(stepIndex(job, "snapshot"));
      expect(healing).toBeLessThan(stepIndex(job, "deploy"));
      expect(steps[healing]?.run).toContain("exit 1");
    },
  );
});

// Two pushes close together each start a run, and either run's stack job can
// reach the stack's group first. scripts/dev-deploy-order.ts refuses a commit
// older than one the stack already passed on dev; these hold each stack job to
// running it where it counts and to deploying nothing when it refuses.
describe("each stack job refuses a commit older than one its stack already passed on dev", () => {
  const ORDER_REFUSED =
    "${{ (inputs.force == true || inputs.expect_no_change == true) && steps.order.outputs.deploy == 'false' }}";

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: checks out full history, which the check reads ancestry from, and leaves no job token on disk",
    (key) => {
      const checkouts = checkoutsOf(stackJobOf(key));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: runs the check for its own stack after the token check and before the snapshot, holding the job token alone, under a time limit",
    (key) => {
      const job = stackJobOf(key);
      const order = stepById(job, "order");
      expect(order?.run).toBe(`bun run scripts/dev-deploy-order.ts --stack ${key}`);
      expect(order?.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
      expect(order?.if).toBeUndefined();
      expect(order?.["continue-on-error"]).toBeUndefined();
      expect(order?.["timeout-minutes"]).toBe(5);
      expect(stepIndex(job, "order")).toBeGreaterThan(stepIndex(job, "token"));
      expect(stepIndex(job, "order")).toBeLessThan(stepIndex(job, "snapshot"));
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: on a refusal no step that holds the Cloudflare token runs before the deploy, nor the deploy",
    (key) => {
      const job = stackJobOf(key);
      const steps = stepsOf(job);
      const between = steps.slice(stepIndex(job, "order") + 1, stepIndex(job, "deploy") + 1);
      const holding = between.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined);
      expect(holding.map((step) => step.id)).toEqual(["snapshot", "deploy"]);
      for (const step of holding) expect(step.if).toBe(ON_ORDER);
    },
  );

  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: a refused force or expect_no_change dispatch fails the job before the snapshot, since it re-uploads nothing and proves nothing",
    (key) => {
      const job = stackJobOf(key);
      const steps = stepsOf(job);
      const refuse = steps.findIndex((step) => step.if === ORDER_REFUSED);
      expect(refuse).toBeGreaterThan(stepIndex(job, "order"));
      expect(refuse).toBeLessThan(stepIndex(job, "snapshot"));
      const ran = runStep(steps[refuse]!, {});
      expect(ran.exitCode).not.toBe(0);
      expect(ran.output).toContain("::error::");
      expect(ran.bunCalls).toEqual([]);
    },
  );
});

describe("PR1: the cire stack job compares the guest site's routes with Wrangler's runtime after every smoke check", () => {
  const job = stackJobOf("cire");
  const steps = stepsOf(job);
  const parity = stepById(job, "parity_cire_invites");

  test("runs after the last smoke check, only once the guest site's passed, and never fails the job by itself", () => {
    const at = stepIndex(job, "parity_cire_invites");
    const smokes = surfacesOf("cire").map((s) => stepIndex(job, `smoke_${s.key}`));
    expect(at).toBeGreaterThan(Math.max(...smokes));
    expect(parity?.if).toBe("${{ !cancelled() && steps.smoke_cire_invites.outcome == 'success' }}");
    expect(parity?.["continue-on-error"]).toBe(true);
    expect(parity?.["timeout-minutes"]).toBe(5);
    expect(parity?.run).toBe(
      'bun run scripts/guest-route-parity.ts --out "$RUNNER_TEMP/route-parity/cire-invites.json"',
    );
  });

  test("holds the guest site's dev origin, the cire-api origin its build calls, and the Access service token, and nothing else", () => {
    expect(parity?.env).toEqual({
      PARITY_ORIGIN: hostOutput("cire_invites_origin"),
      PARITY_API_ORIGIN: hostOutput("cire_api_origin"),
      CF_ACCESS_CLIENT_ID: "${{ secrets.CF_ACCESS_CLIENT_ID }}",
      CF_ACCESS_CLIENT_SECRET: "${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
    });
  });

  test("keeps the report as an artifact whenever the comparison ran, failed or not", () => {
    const upload = steps[stepIndex(job, "parity_cire_invites") + 1];
    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(upload?.if).toBe(
      "${{ !cancelled() && steps.parity_cire_invites.outcome != 'skipped' }}",
    );
    expect(upload?.with).toEqual({
      name: "cire-invites-route-parity",
      path: "${{ runner.temp }}/route-parity/",
      "if-no-files-found": "warn",
    });
  });
});

/** The two script test files that `bun test ./scripts/` skips, each run by a root script of its own. */
const WRANGLER_TEST = "scripts/tests/guest-route-parity-wrangler.e2e.ts";
const RELAY_IDLE_TEST = "scripts/tests/guest-route-parity-relay-idle.slow.ts";
/** The names `bun test` picks up: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*`. */
const BUN_TEST_NAME = /[._](test|spec)\.[cm]?[jt]sx?$/;

const rootScripts = (): Readonly<Record<string, string>> =>
  (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    }
  ).scripts;

describe("PR2: ci.yml's Build & Test job runs the guest route comparison's reference on real Wrangler, and keeps its logs", () => {
  const RUN = "bun run test:scripts:wrangler";
  const steps = stepsOf(load(".github/workflows/ci.yml").jobs["build-test"]);
  const at = steps.findIndex((step) => step.run === RUN);

  test("a step of its own runs it, under a time limit, and fails the job when it fails", () => {
    expect(at).toBeGreaterThan(-1);
    const step = steps[at];
    expect(step?.["timeout-minutes"]).toBeNumber();
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
    // After the install: it loads the wrangler cire/invites resolves.
    expect(at).toBeGreaterThan(
      steps.findIndex((one) => one.run === "bun install --frozen-lockfile"),
    );
  });

  test("the step after it keeps test-artifacts/ whether the test passed or not", () => {
    const upload = steps[at + 1];
    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(upload?.if).toBe("${{ !cancelled() }}");
    expect(upload?.with?.path).toBe("test-artifacts/");
  });

  test("the root script runs the real-Wrangler test file, which the Scripts job's `bun test ./scripts/` does not pick up", () => {
    const scripts = rootScripts();
    expect(scripts["test:scripts:wrangler"]).toBe(`bun test ./${WRANGLER_TEST}`);
    expect(existsSync(join(root, WRANGLER_TEST))).toBe(true);
    expect(scripts["test:scripts"]).toBe("bun test ./scripts/");
    expect(WRANGLER_TEST).not.toMatch(BUN_TEST_NAME);
  });
});

describe("ci.yml's Build & Test job checks the cire sites' links to their directory pages", () => {
  const RUN = "bun run scripts/check-directory-links.ts";
  const steps = stepsOf(load(".github/workflows/ci.yml").jobs["build-test"]);
  const at = steps.findIndex((step) => step.run === RUN);

  test("a step of its own runs the check after the build, and fails the job when it fails", () => {
    // The check reads the four sites' `dist/`, which only the build writes.
    expect(at).toBeGreaterThan(steps.findIndex((one) => one.run === "bun run build"));
    expect(steps.findIndex((one) => one.run === "bun run build")).toBeGreaterThan(-1);
    expect(steps[at]?.if).toBeUndefined();
    expect(steps[at]?.["continue-on-error"]).toBeUndefined();
  });
});

describe("ci.yml's `CI` gate, the one required check, covers every job beside Build & Test", () => {
  const ci = load(".github/workflows/ci.yml");
  const needs = [ci.jobs.ci?.needs ?? []].flat();

  // A job missing from `needs` can be red while the merge goes through.
  test("the gate needs every job but E2E, which reports without gating", () => {
    const gated = Object.keys(ci.jobs)
      .filter((id) => id !== "ci" && id !== "e2e")
      .toSorted();
    expect(needs.toSorted()).toEqual(gated);
  });

  // A filter that names no package matches nothing, and turbo passes.
  test("`@cire/api`'s unit tests are left out of Build & Test by the name of a real workspace, and run in their own job", () => {
    const runsOf = (id: string) => stepsOf(ci.jobs[id]).map((step) => step.run ?? "");
    const name = (
      JSON.parse(readFileSync(join(root, "cire/api/package.json"), "utf8")) as { name: string }
    ).name;
    expect(name).toBe("@cire/api");
    expect(runsOf("build-test")).toContain(`bun run test --filter='!${name}'`);
    expect(runsOf("cire-api-tests")).toContain(
      `bun run test --filter=${name} --cache-dir=.turbo/cire-api -- --parallel`,
    );
  });

  // A merge-queue group runs on a `gh-readonly-queue/*` ref that no later run
  // can restore from, so a cache saved there is space and nothing else. A save
  // may add conditions of its own after that one, joined by `&&`. This checks
  // the separate save steps only; an `actions/cache` step saves in its post
  // step, which no `if` here reaches.
  test("no actions/cache/save step runs on a merge-queue run", () => {
    const saves = Object.values(ci.jobs)
      .flatMap((job) => stepsOf(job))
      .filter((step) => step.uses === "actions/cache/save@v4");
    expect(saves.length).toBeGreaterThan(0);
    for (const step of saves) {
      expect({ path: step.with?.path, if: step.if }).toEqual({
        path: step.with?.path,
        if: expect.stringMatching(/^github\.event_name != 'merge_group'( && [^|]+)?$/),
      });
    }
  });

  // scripts/install-chromium-system-libraries.sh runs as root on what this
  // cache restores. A prefix fallback would hand a run the packages saved for
  // another image or Playwright version, so every step on the cache names one
  // exact key, and both jobs build it with the same command.
  test("Chromium's system packages are cached under one exact key, built the same way by the browser legs and the E2E job", () => {
    const onCache = Object.entries(ci.jobs).flatMap(([id, job]) =>
      stepsOf(job)
        .filter((step) => step.with?.path === "~/.cache/chromium-apt")
        .map((step) => ({
          id,
          uses: step.uses,
          key: step.with?.key,
          fallback: step.with?.["restore-keys"],
        })),
    );
    expect(onCache).toEqual([
      {
        id: "browser",
        uses: "actions/cache/restore@v4",
        key: "${{ steps.chromium-apt-key.outputs.key }}",
        fallback: undefined,
      },
      {
        id: "e2e",
        uses: "actions/cache/restore@v4",
        key: "${{ steps.chromium-apt-key.outputs.key }}",
        fallback: undefined,
      },
      {
        id: "e2e",
        uses: "actions/cache/save@v4",
        key: "${{ steps.chromium-apt.outputs.cache-primary-key }}",
        fallback: undefined,
      },
    ]);
    const keyed = (id: string) =>
      stepsOf(ci.jobs[id]).find((step) => step.id === "chromium-apt-key")?.run;
    expect(keyed("browser")).toContain(
      "chromium-apt-${ImageOS:-unknown}-${ImageVersion:-unknown}-playwright-",
    );
    expect(keyed("e2e")).toBe(keyed("browser"));
  });

  // The secret scan runs the gitleaks a cached tarball holds.
  // scripts/install-gitleaks.sh checks that tarball's SHA-256 before it unpacks
  // anything, as install-gitleaks.cli.test.ts shows; here, the job hands the
  // script the directory the cache restores, and the key carries the pinned
  // SHA-256, so a new pin never restores the old tarball and fails the check.
  test("the secret scan's gitleaks tarball is restored under its pinned SHA-256 and goes through the script that checks it", () => {
    const steps = stepsOf(ci.jobs.secrets);
    expect(ci.jobs.secrets?.env).toEqual({
      GITLEAKS_VERSION: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      GITLEAKS_SHA256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const restore = steps.findIndex((step) => step.id === "gitleaks-cache");
    const install = steps.findIndex((step) =>
      step.run?.includes('bash scripts/install-gitleaks.sh "$HOME/.cache/gitleaks" "$RUNNER_TEMP"'),
    );
    const save = steps.findIndex(
      (step) => step.uses === "actions/cache/save@v4" && step.with?.path === "~/.cache/gitleaks",
    );
    expect({
      restore: steps[restore]?.uses,
      path: steps[restore]?.with?.path,
      key: steps[restore]?.with?.key,
      fallback: steps[restore]?.with?.["restore-keys"],
      saveKey: steps[save]?.with?.key,
    }).toEqual({
      restore: "actions/cache/restore@v4",
      path: "~/.cache/gitleaks",
      key: "gitleaks-${{ env.GITLEAKS_VERSION }}-linux_x64-${{ env.GITLEAKS_SHA256 }}",
      fallback: undefined,
      saveKey: "${{ steps.gitleaks-cache.outputs.cache-primary-key }}",
    });
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(restore);
    expect(save).toBeGreaterThan(install);
    expect(steps.filter((step) => step.with?.path === "~/.cache/gitleaks")).toHaveLength(2);
  });

  // The secret scan must finish on every pushed commit, so nothing that cancels
  // a superseded run may reach it: no workflow group, and none on the job.
  test("no concurrency group can cancel the secret scan", () => {
    expect(ci.concurrency).toBeUndefined();
    expect(ci.jobs.secrets?.concurrency).toBeUndefined();
  });

  // A newer push cancels only a pull request's superseded jobs, one group per
  // job and leg, so jobs of one run never queue behind each other; a run on
  // main or in the merge queue takes its run id and is never cancelled.
  test("each cancellable job is grouped by its own name, and only a pull request cancels", () => {
    const grouped = Object.entries(ci.jobs).filter(([, job]) => job.concurrency !== undefined);
    expect(grouped.map(([id]) => id).toSorted()).toEqual(
      ["browser", "build-test", "cire-api-tests", "d1", "e2e", "migration-flow"].toSorted(),
    );
    for (const [id, job] of grouped) {
      const [key, extra] = id === "browser" ? [`${id}-{1}`, ", matrix.leg"] : [id, ""];
      expect({ id, concurrency: job.concurrency }).toEqual({
        id,
        concurrency: {
          group: `\${{ format('ci-{0}-${key}', github.event_name == 'pull_request' && github.ref || github.run_id${extra}) }}`,
          "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
        },
      });
    }
  });
});

describe("ci.yml skips its build, test and E2E jobs for a prose-only change, and only those", () => {
  const ci = load(".github/workflows/ci.yml");
  const SKIP = "needs.changes.outputs.docs-only != 'true'";
  const SKIPPABLE = [
    "browser",
    "build-test",
    "cire-api-tests",
    "d1",
    "e2e",
    "migration-flow",
    "openapi-freshness",
    "typecheck",
  ];

  // A job that waits on the detection and is not in the list can be skipped
  // with nothing here saying so; one in the list that does not wait runs
  // anyway. The lint, script and secret checks read prose too, so they never
  // wait.
  test("each build, test and E2E job runs unless the detection says prose only; lint, scripts and the secret scan always run", () => {
    const waiting = Object.entries(ci.jobs)
      .filter(([, job]) => needsOf(job).includes("changes"))
      .map(([id]) => id);
    expect(waiting.toSorted()).toEqual([...SKIPPABLE, "ci"].toSorted());
    for (const id of SKIPPABLE) {
      expect({ id, if: ci.jobs[id]?.if }).toEqual({
        id,
        if: id === "e2e" ? `github.event_name != 'merge_group' && ${SKIP}` : SKIP,
      });
    }
    for (const id of ["lint", "script-tests", "secrets", "changes"]) {
      expect({ id, if: ci.jobs[id]?.if, needs: ci.jobs[id]?.needs }).toEqual({
        id,
        if: undefined,
        needs: undefined,
      });
    }
  });

  // The classify step, run as GitHub runs it, in a throwaway repository whose
  // commits stand for the change and, for a queue group, the entries ahead of
  // it.
  const classifyStep = stepsOf(ci.jobs.changes).find((step) => step.id === "classify");
  const docsOnly = readFileSync(join(root, "scripts/docs-only.sh"), "utf8");

  /** A file written with its commit's number, a file written as given, or a `git mv`. */
  type Change =
    | string
    | { readonly write: string; readonly content: string }
    | { readonly move: string; readonly to: string };

  function classify(
    commits: readonly (readonly Change[])[],
    event: (shas: readonly string[]) => Record<string, string>,
    { classifierOnBase = true } = {},
  ): { readonly exitCode: number; readonly output: string; readonly verdict: string } {
    const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: dir,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    git("init", "-q", "-b", "main");
    write("osn/api/src/base.ts", "export const base = 1;\n");
    if (classifierOnBase) write("scripts/docs-only.sh", docsOnly);
    git("add", ".");
    git("commit", "-qm", "base");
    const shas = [git("rev-parse", "HEAD")];
    for (const changes of commits) {
      for (const change of changes) {
        if (typeof change === "string") write(change, `${shas.length}\n`);
        else if ("write" in change) write(change.write, change.content);
        else {
          mkdirSync(dirname(join(dir, change.to)), { recursive: true });
          git("mv", change.move, change.to);
        }
      }
      git("add", ".");
      git("commit", "-qm", `commit ${shas.length}`);
      shas.push(git("rev-parse", "HEAD"));
    }
    const outputFile = join(dir, "github-output");
    const runnerTemp = mkdtempSync(join(tmpdir(), "ci-changes-runner-"));
    const result = Bun.spawnSync(
      ["bash", "--noprofile", "--norc", "-e", "-c", classifyStep?.run ?? "exit 9"],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_OUTPUT: outputFile,
          RUNNER_TEMP: runnerTemp,
          ...event(shas),
        },
      },
    );
    const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      verdict: /^docs-only=(.*)$/m.exec(written)?.[1] ?? "<none>",
    };
  }

  const pullRequest = () => ({ EVENT: "pull_request" });
  const queue = (shas: readonly string[]) => ({ EVENT: "merge_group", QUEUE_BASE: shas[0] ?? "" });

  test.each([
    ["a pull request of prose", "true", [["wiki/a.md", "README.md"]], pullRequest],
    [
      "a pull request with one source file",
      "false",
      [["wiki/a.md", "osn/api/src/a.ts"]],
      pullRequest,
    ],
    // The queue tests a group's last entry on top of the ones ahead of it, so
    // its diff starts at the queue's base, not at the entry before it.
    [
      "a queue group whose prose entry follows one with code",
      "false",
      [["osn/api/src/a.ts"], ["wiki/a.md"]],
      queue,
    ],
    ["a queue group of prose entries", "true", [["wiki/a.md"], ["README.md"]], queue],
    [
      "a push of prose",
      "true",
      [["wiki/a.md"]],
      (shas: readonly string[]) => ({ EVENT: "push", BEFORE: shas[0] ?? "" }),
    ],
    // A branch's first push, or a force-push: no commit to diff against.
    [
      "a push whose previous commit is not there",
      "false",
      [["wiki/a.md"]],
      () => ({ EVENT: "push", BEFORE: "0000000000000000000000000000000000000000" }),
    ],
    // `git diff --name-only` names only a rename's new path unless told not
    // to, so code moved under wiki/ would read as a wiki page.
    [
      "a pull request that moves code under wiki/",
      "false",
      [[{ move: "osn/api/src/base.ts", to: "wiki/base.ts" }]],
      pullRequest,
    ],
    // The change's own classifier would answer for it.
    [
      "a pull request whose edited classifier says prose",
      "false",
      [[{ write: "scripts/docs-only.sh", content: "echo true\n" }, "osn/api/src/a.ts"]],
      pullRequest,
    ],
  ] as const)("%s: prose only is %s", (_, expected, commits, event) => {
    const { exitCode, output, verdict } = classify(commits, event);
    expect({ exitCode, verdict }, output).toEqual({ exitCode: 0, verdict: expected });
  });

  test("a base with no classifier yet runs every job", () => {
    const { exitCode, output, verdict } = classify([["wiki/a.md"]], pullRequest, {
      classifierOnBase: false,
    });
    expect({ exitCode, verdict }, output).toEqual({ exitCode: 0, verdict: "false" });
  });
});

describe("CI's E2E job runs the suite once and retries the whole run; the determinism check runs where a flow can change", () => {
  const ci = load(".github/workflows/ci.yml");
  const repro = load(".github/workflows/e2e-repro.yml");
  const e2e = ci.jobs.e2e;
  const SETUP = "./.github/actions/e2e-setup";

  // The step's limit must hold every run at its own limit plus retry.sh's
  // grace and clean-up, or the step cuts the last run instead of retry.sh; and
  // a run's directory that no step uploads is lost with the runner.
  test("the `E2E` step retries test:e2e as a whole run, has room for every run, and uploads each failed run's artifacts beside the last run's", () => {
    expect(e2e?.name).toBe("E2E");
    const steps = e2e?.steps ?? [];
    expect(steps.filter((step) => step.run?.includes("test:e2e:repro"))).toEqual([]);
    const step = steps.find((one) => one.run?.includes("e2e-with-retry.sh"));
    const match = /^bash scripts\/e2e-with-retry\.sh (\d+) (\d+) bun run test:e2e$/.exec(
      step?.run ?? "",
    );
    expect(match, step?.run).not.toBeNull();
    const [attempts, seconds] = [Number(match?.[1]), Number(match?.[2])];
    expect(attempts).toBeGreaterThan(1);
    const stepMinutes = step?.["timeout-minutes"] ?? 0;
    expect(stepMinutes * 60).toBeGreaterThan(attempts * (seconds + 30 + 10));
    expect(e2e?.["timeout-minutes"] ?? 0).toBeGreaterThan(stepMinutes);
    const uploads = steps
      .filter((one) => one.uses === "actions/upload-artifact@v4")
      .map((one) => ({ if: one.if, name: one.with?.name, path: one.with?.path }));
    expect(uploads).toEqual([
      ...Array.from({ length: attempts - 1 }, (_, i) => ({
        if: "always()",
        name: `e2e-artifacts-attempt-${i + 1}`,
        path: `e2e-artifacts-attempt-${i + 1}/`,
      })),
      { if: "always()", name: "e2e-artifacts", path: "e2e-artifacts/" },
    ]);
  });

  // Without the paths, every pull request pays for two more runs of the suite;
  // with a path that names nothing, the check never runs.
  test("the determinism job runs test:e2e:repro daily, by hand, and on a push to main or a pull request that changes tools/e2e, and never in the merge queue", () => {
    expect(Object.keys(repro.on).toSorted()).toEqual([
      "pull_request",
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
    const paths = ["tools/e2e/**", ".github/workflows/e2e-repro.yml", `${SETUP.slice(2)}/**`];
    expect(repro.on.pull_request).toEqual({ paths });
    expect(repro.on.push).toEqual({ branches: ["main"], paths });
    for (const path of paths)
      expect(existsSync(join(root, path.replace(/\/\*\*$/, "")))).toBe(true);
    expect(repro.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(repro.jobs);
    expect(jobs.map((job) => job.name)).toEqual(["E2E determinism"]);
    expect(
      (jobs[0]?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run])),
    ).toEqual(["bun run test:e2e:repro"]);
  });

  test("both jobs set up through the one shared action, straight after the checkout", () => {
    for (const job of [e2e, repro.jobs.repro]) {
      expect((job?.steps ?? []).slice(0, 2).map((step) => step.uses)).toEqual([
        "actions/checkout@v4",
        SETUP,
      ]);
    }
  });
});

describe("ci.yml's browser legs run every package with a `test:browser` script, once", () => {
  const legs = load(".github/workflows/ci.yml").jobs.browser?.strategy?.matrix?.include ?? [];
  const named = (leg: Record<string, string | number>) =>
    [...String(leg.filters ?? "").matchAll(/--filter=(\S+)/g)].map((match) => match[1] ?? "");

  // A package left out of every leg runs no browser test in CI, and nothing
  // turns red.
  test("the legs' filters name exactly the workspace packages that have the script", () => {
    const readJson = <T>(path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
    const withScript = readJson<{ workspaces: string[] }>("package.json")
      .workspaces.flatMap((pattern) =>
        Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })),
      )
      .map((path) => readJson<{ name: string; scripts?: Record<string, string> }>(path))
      .filter((pkg) => pkg.scripts?.["test:browser"] !== undefined)
      .map((pkg) => pkg.name)
      .toSorted();
    expect(withScript.length).toBeGreaterThan(0);
    expect(legs.flatMap(named).toSorted()).toEqual(withScript);
  });

  // Each leg checks at run time that turbo found `expect` packages, so the
  // number must be the count its filters name.
  test("each leg's `expect` is the number of packages its filters name", () => {
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect({ leg: leg.leg, expect: Number(leg.expect) }).toEqual({
        leg: leg.leg,
        expect: named(leg).length,
      });
    }
  });
});

describe("PR2: ci.yml's Scripts job runs the relay's idle-timeout test, which needs no install, apart from `bun test ./scripts/`", () => {
  const RUN = "bun run test:scripts:relay-idle";
  const steps = stepsOf(load(".github/workflows/ci.yml").jobs["script-tests"]);
  const at = steps.findIndex((step) => step.run === RUN);

  test("a step of its own runs it after Bun is set up, under a time limit, and fails the job when it fails", () => {
    expect(at).toBeGreaterThan(-1);
    const step = steps[at];
    expect(step?.["timeout-minutes"]).toBeNumber();
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
    const bun = steps.findIndex((one) => one.uses?.startsWith("oven-sh/setup-bun@") === true);
    expect(bun).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(bun);
  });

  test("the root script runs the idle-timeout test file, which `bun test ./scripts/` does not pick up", () => {
    expect(rootScripts()["test:scripts:relay-idle"]).toBe(`bun test ./${RELAY_IDLE_TEST}`);
    expect(existsSync(join(root, RELAY_IDLE_TEST))).toBe(true);
    expect(RELAY_IDLE_TEST).not.toMatch(BUN_TEST_NAME);
  });

  test("neither file run by name can skip, mark or single out a test, so each fails rather than skips", () => {
    for (const file of [WRANGLER_TEST, RELAY_IDLE_TEST]) {
      const source = readFileSync(join(root, file), "utf8");
      expect({ [file]: source.match(/\.(skip|todo|skipIf|if|only)\b/g) ?? [] }).toEqual({
        [file]: [],
      });
    }
  });
});

describe("W2: one record job per dev surface", () => {
  test.each(STACKS.map((s) => [s.key] as const))(
    "%s: the stack job reports whether it deployed, and each surface's check",
    (key) => {
      const outputs = stackJobOf(key).outputs ?? {};
      expect(Object.keys(outputs).toSorted()).toEqual(
        ["deployed", ...surfacesOf(key).map((s) => `${s.key}_healthy`)].toSorted(),
      );
      // A deploy or compare that failed may have left a Worker un-uploaded, so
      // no surface of the stack records success.
      expect(outputs.deployed).toBe(
        "${{ steps.deploy.outcome == 'success' && steps.deployments.outcome == 'success' }}",
      );
      for (const s of surfacesOf(key)) {
        expect(outputs[`${s.key}_healthy`]).toBe(
          `\${{ steps.smoke_${s.key}.outcome == 'success' }}`,
        );
      }
    },
  );

  test.each(SURFACES.map((s) => [s.key, s] as const))(
    "%s: the record job carries the map's name, needs only its stack job and runs when its check passed",
    (key, s) => {
      const job = dev.jobs[s.dev.id]!;
      const stackJob = stack(s.stack).job.id;
      expect(job.name).toBe(s.dev.name);
      expect(needsOf(job)).toEqual([stackJob]);
      expect(environmentOf(job)).toBe("dev");
      expect(job.if).toBe(
        `\${{ !cancelled() && needs.${stackJob}.outputs.deployed == 'true' && needs.${stackJob}.outputs.${key}_healthy == 'true' }}`,
      );
      // It exists to leave a Deployment record; it checks nothing out and
      // holds nothing.
      expect(stepsOf(job).some((step) => step.uses !== undefined)).toBe(false);
      expect(JSON.stringify(job)).not.toContain("secrets.");
    },
  );
});

describe("production-release.yml", () => {
  test("PW11: runs on a schedule and by hand, with the two inputs the planner reads", () => {
    expect(Object.keys(production.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
    const dispatch = production.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default?: unknown }>;
    };
    expect(Object.keys(dispatch.inputs).toSorted()).toEqual(["force", "surfaces"]);
    expect(dispatch.inputs.surfaces?.type).toBe("string");
    expect(dispatch.inputs.force?.type).toBe("boolean");
  });

  test("PW10: every Alchemy run in it sends no telemetry", () => {
    expect(production.env?.DO_NOT_TRACK).toBe("1");
  });

  test("PW10: no production Alchemy run writes to the public run log: each writes a file, which the next step shows only when the run failed", () => {
    const alchemyRuns = Object.values(production.jobs).flatMap((job) =>
      stepsOf(job).flatMap((step, at) =>
        /\b(plan|deploy):production\b/.test(step.run ?? "") ? [{ job, step, at }] : [],
      ),
    );
    // Per stack: a plan at approval 1, and a re-plan and a deploy in its stack job.
    expect(alchemyRuns).toHaveLength(3 * PRODUCTION_STACKS.length);
    for (const { job, step, at } of alchemyRuns) {
      expect(step.run).not.toMatch(/\btee\b|\|/);
      const file = /> "(\$RUNNER_TEMP\/[^"]+\.log)" 2>&1\s*$/.exec(step.run ?? "")?.[1];
      expect({ step: step.name, file: file !== undefined }).toEqual({
        step: step.name,
        file: true,
      });
      for (const exit of [0, 3]) {
        const ran = runStep(step, { FORCE: "" }, exit);
        expect({ step: step.name, exit, shown: ran.output.includes(BUN_OUTPUT) }).toEqual({
          step: step.name,
          exit,
          shown: false,
        });
      }
      const show = stepsOf(job)[at + 1];
      expect(show?.if).toBe(`\${{ failure() && steps.${step.id}.outcome == 'failure' }}`);
      expect(show?.run).toBe(`cat "${file}"`);
    }
  });

  test("one release at a time, never cancelling one in progress", () => {
    expect(production.concurrency?.group).toStartWith("production-release-");
    expect(production.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("PW11: the plan job can read deployments and job names, and outputs every surface and production stack", () => {
    const plan = production.jobs.plan!;
    expect(plan.permissions).toEqual({ contents: "read", deployments: "read", actions: "read" });
    const outputs = plan.outputs ?? {};
    expect(Object.keys(outputs).toSorted()).toEqual(
      [
        ...PRODUCTION_SURFACES.map((s) => s.key),
        ...PRODUCTION_STACKS.map((s) => `stack_${s.key}`),
        "any",
        "any_stack",
      ].toSorted(),
    );
    for (const key of Object.keys(outputs))
      expect(outputs[key]).toBe(`\${{ steps.plan.outputs.${key} }}`);
  });

  test("the plan job refuses any ref but main before it does anything else", () => {
    const [guard] = stepsOf(production.jobs.plan);
    expect(guard?.if).toBe("github.ref != 'refs/heads/main'");
    expect(guard?.run).toContain("exit 1");
  });

  test("the plan job runs the planner over full history, with the token and every input", () => {
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

  test("no checkout leaves the job token on disk; a record job checks nothing out", () => {
    const records = new Set(recordSurfaces.map((s) => s.production.id));
    for (const [id, job] of Object.entries(production.jobs)) {
      expect({ id, checkouts: checkoutsOf(job).length }).toEqual({
        id,
        checkouts: records.has(id) ? 0 : 1,
      });
    }
    const checkouts = Object.values(production.jobs).flatMap((job) => checkoutsOf(job));
    for (const checkout of checkouts) expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  test("the surfaces input lists exactly the map's keys", () => {
    const dispatch = production.on.workflow_dispatch as {
      inputs: Record<string, { description: string }>;
    };
    const listed = /: ([a-z_ ]+)\. Empty means all\./.exec(
      dispatch.inputs.surfaces?.description ?? "",
    );
    expect(listed?.[1]?.split(" ")).toEqual(PRODUCTION_SURFACES.map((s) => s.key));
  });

  test("build runs only when something ships", () => {
    const build = production.jobs.build!;
    expect(needsOf(build)).toEqual(["plan"]);
    expect(build.if).toBe("needs.plan.outputs.any == 'true'");
  });

  test("its production jobs are the map's own jobs, alchemy-plan and each stack's job; its record jobs the map's stack sites", () => {
    const ids = jobsIn(production, "production").map(([id]) => id);
    expect(ids.toSorted()).toEqual(
      [
        ...ownJobSurfaces.map((s) => s.production.id),
        "alchemy-plan",
        ...PRODUCTION_STACKS.map((s) => s.production.id),
      ].toSorted(),
    );
    expect(
      jobsIn(production, "production-records")
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(recordSurfaces.map((s) => s.production.id).toSorted());
    // Nothing else holds an Environment: the plan, build and sites jobs read no secret.
    expect(
      Object.entries(production.jobs)
        .filter(([, job]) => environmentOf(job) === undefined)
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(["build", "plan", "sites"]);
  });

  test("zap-api migrates, deploys and checks on every release that ships it, with no step skipping them", () => {
    const job = production.jobs["deploy-zap-api"]!;
    const steps = stepsOf(job);
    const migrate = steps.find((step) =>
      /\bd1 migrations apply zap-db-prod\b/.test(step.run ?? ""),
    );
    const deploy = steps.find((step) => step.run === "bunx wrangler deploy --env production");
    const smoke = steps.find(
      (step) => step.run === "bun run scripts/smoke-check.ts zap_api production",
    );
    for (const step of [migrate, deploy, smoke]) {
      expect({ step: step?.name, if: step?.if }).toEqual({ step: step?.name, if: undefined });
    }
    expect(steps.some((step) => step.id === "zapcheck")).toBe(false);
  });

  test("RP8: each Environment keeps its own window: a release leaves at most 7 records in production (42 releases) and 5 in production-records (60)", () => {
    // Counted with one attempt per job: a re-run, or a rejected approval,
    // leaves a record of its own.
    const inProduction = jobsIn(production, "production").map(([id]) => id);
    // A release runs at most every production job.
    const release = inProduction.length;
    expect(release).toBe(7);
    expect(Math.floor(MAX_RECORDS / release)).toBeGreaterThanOrEqual(42);
    // One record job per site whose Worker serves its host: at most every
    // site a production stack deploys.
    const records = jobsIn(production, "production-records").length;
    const sites = PRODUCTION_SURFACES.filter(stackDeployed).length;
    expect(records).toBeLessThanOrEqual(sites);
    expect(sites).toBeLessThanOrEqual(5);
    expect(Math.floor(MAX_RECORDS / 5)).toBeGreaterThanOrEqual(60);
  });

  test.each(ownJobSurfaces.map((s) => [s.key, s] as const))(
    "PW-a %s: named as the map says, gated on its own output and on every job before the gate, released by the deploy approval",
    (key, s) => {
      const job = production.jobs[s.production.id]!;
      expect(job.name).toBe(s.production.name);
      expect(job.if).toBe(
        `\${{ !cancelled() && needs.plan.outputs.${key} == 'true' && needs.build.result == 'success' && (needs.sites.result == 'success' || needs.sites.result == 'skipped') && (needs.alchemy-plan.result == 'success' || needs.alchemy-plan.result == 'skipped') }}`,
      );
      expect(environmentOf(job)).toBe("production");
      expect(needsOf(job).toSorted()).toEqual(GATE_NEEDS);
      expect(job.concurrency).toEqual({
        group: `deploy-production-${s.production.id.slice("deploy-".length)}`,
        "cancel-in-progress": false,
      });
    },
  );
});

const GATE_NEEDS = ["alchemy-plan", "build", "plan", "sites"];

/** A production stack's job in production-release.yml. */
const productionStackJob = (key: StackKey): Job => {
  const id = PRODUCTION_STACKS.find((s) => s.key === key)?.production.id ?? "";
  const job = production.jobs[id];
  if (job === undefined) throw new Error(`production-release.yml has no ${id} job`);
  return job;
};
/** The sites a production stack deploys, in map order. */
const productionSitesOf = (key: StackKey): readonly SiteSurface[] =>
  PRODUCTION_SURFACES.filter((s) => s.stack === key && stackDeployed(s)).map(
    (s) => s.key as SiteSurface,
  );
const PRODUCTION_CREDENTIALS = {
  CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
} as const;
const ON_DEPLOY = "${{ !cancelled() && steps.deploy.outcome != 'skipped' }}";
/** What each guard step reads to know a scheduled run: `yes` on one, empty otherwise. */
const SCHEDULED_RUN = "${{ github.event_name == 'schedule' && 'yes' || '' }}";
const sitesJob = production.jobs.sites!;
const planJob = production.jobs["alchemy-plan"]!;

/**
 * The production build of each site, with exactly the values it bakes in:
 * today's production hosts, and musubi landing's on www.musubi.social with
 * the app on musubi.social.
 */
const PRODUCTION_BUILDS: Readonly<Partial<Record<SiteSurface, Record<string, string>>>> = {
  cire_host: {
    PUBLIC_CIRE_API_URL: "https://api.cireweddings.com",
    PUBLIC_OSN_ACCOUNT_URL: "https://musubi.social",
    PUBLIC_CIRE_WEB_URL: "https://invite.cireweddings.com",
    PUBLIC_MARKETING_URL: "https://cireweddings.com",
    PUBLIC_BUILD_SHA: "${{ github.sha }}",
    OSN_DEPLOY_TIER: "production",
  },
  cire_vendor: {
    PUBLIC_CIRE_API_URL: "https://api.cireweddings.com",
    PUBLIC_OSN_ACCOUNT_URL: "https://musubi.social",
    PUBLIC_BUILD_SHA: "${{ github.sha }}",
    OSN_DEPLOY_TIER: "production",
  },
  cire_landing: {
    PUBLIC_ORGANISER_URL: "https://host.cireweddings.com",
    SITE: "https://cireweddings.com",
    PUBLIC_BUILD_SHA: "${{ github.sha }}",
  },
  osn_social: {
    VITE_OSN_ISSUER_URL: "https://id.musubi.social",
    VITE_TURNSTILE_SITEKEY: "${{ vars.PUBLIC_TURNSTILE_SITEKEY }}",
  },
  musubi_landing: { SITE: "https://www.musubi.social", PUBLIC_APP_URL: "https://musubi.social" },
};

describe("PW4: the sites job builds each production site once", () => {
  // In map order, the order the job builds them.
  const sites = PRODUCTION_SURFACES.filter(stackDeployed).map((s) => s.key as SiteSurface);

  test("needs the plan alone, so it runs beside build, runs when a site build is needed, restores no turbo cache, and holds no Environment or secret", () => {
    expect(needsOf(sitesJob)).toEqual(["plan"]);
    expect(stepsOf(sitesJob).filter((step) => step.with?.path === ".turbo")).toEqual([]);
    expect(sitesJob.if).toBe("needs.plan.outputs.any_stack == 'true'");
    expect(environmentOf(sitesJob)).toBeUndefined();
    expect(JSON.stringify(sitesJob)).not.toContain("secrets.");
  });

  test.each(sites.map((site) => [site] as const))(
    "%s: one build with its production values, when its stack ships",
    (site) => {
      const pkg = SITE_BUILDS[site].package;
      const builds = buildsOf(sitesJob).filter((step) => BUILD.exec(step.run ?? "")?.[1] === pkg);
      expect(builds).toHaveLength(1);
      expect(builds[0]?.env).toEqual(PRODUCTION_BUILDS[site]);
      expect(builds[0]?.if).toBe(`needs.plan.outputs.stack_${surface(site).stack} == 'true'`);
    },
  );

  test("builds nothing else, and keeps every build with its hidden files", () => {
    expect(buildsOf(sitesJob)).toHaveLength(sites.length);
    const steps = stepsOf(sitesJob);
    const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
    expect(upload?.with).toEqual({
      name: "production-sites",
      path: ["production-sites.txt", ...sites.map((site) => SITE_BUILDS[site].directory), ""].join(
        "\n",
      ),
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 7,
    });
    expect(steps.indexOf(upload!)).toBe(steps.length - 1);
    // The builds a token-holding job lets in are the ones uploaded.
    expect(SITE_DIRECTORIES).toEqual(sites.map((site) => SITE_BUILDS[site].directory));
  });

  test("musubi social's build is refused without the Turnstile sitekey, before it runs", () => {
    const steps = stepsOf(sitesJob);
    const require = steps.findIndex((step) => step.name === "Require the Turnstile sitekey");
    const social = steps.findIndex((step) => step.run?.includes("--filter=@musubi/social"));
    expect(require).toBeGreaterThan(-1);
    expect(require).toBeLessThan(social);
    expect(runStep(steps[require]!, { VITE_TURNSTILE_SITEKEY: "" }).exitCode).not.toBe(0);
    expect(runStep(steps[require]!, { VITE_TURNSTILE_SITEKEY: "0x4AAA" }).exitCode).toBe(0);
  });
});

describe("PW2: alchemy-plan, the first approval, plans each shipping stack and guards it", () => {
  const steps = stepsOf(planJob);
  const at = (id: string) => stepIndex(planJob, id);

  test("needs plan, build and sites, runs when a stack ships, in the production Environment", () => {
    expect(planJob.name).toBe("Plan the Alchemy stacks");
    expect(needsOf(planJob).toSorted()).toEqual(["build", "plan", "sites"]);
    expect(planJob.if).toBe("needs.plan.outputs.any_stack == 'true'");
    expect(environmentOf(planJob)).toBe("production");
    expect(planJob.env).toBeUndefined();
  });

  test("checks the token and the state store, then snapshots, plans to a file and guards each shipping stack, keeping only the guard's record", () => {
    expect(stepById(planJob, "token")?.run).toBe(
      "bun run --cwd shared/infra token:check -- --tier production",
    );
    expect(stepById(planJob, "state")?.run).toContain("bun run --cwd shared/infra state:check");
    for (const id of ["token", "state"])
      expect(stepById(planJob, id)?.env).toEqual(PRODUCTION_CREDENTIALS);
    for (const s of PRODUCTION_STACKS) {
      const snapshot = stepById(planJob, `snapshot_${s.key}`);
      const plan = stepById(planJob, `plan_${s.key}`);
      const guard = stepById(planJob, `guard_${s.key}`);
      const when = `needs.plan.outputs.stack_${s.key} == 'true'`;
      for (const step of [snapshot, plan, guard]) expect(step?.if).toBe(when);
      expect(snapshot?.run).toBe(
        `bun run scripts/worker-deployments.ts snapshot "$RUNNER_TEMP/deployments-${s.key}.json" --tier production ${productionSitesOf(s.key).join(" ")}`,
      );
      expect(snapshot?.env).toEqual(PRODUCTION_CREDENTIALS);
      expect(plan?.["working-directory"]).toBe(`${s.key}/infra`);
      expect(plan?.env).toEqual({
        FORCE: `\${{ steps.snapshot_${s.key}.outputs.force == 'true' && 'yes' || '' }}`,
        DO_NOT_TRACK: "1",
        OSN_DEPLOY_TIER: "production",
        ...PRODUCTION_CREDENTIALS,
      });
      // The raw log goes to a file, never to the public run log.
      expect(runStep(plan!, { FORCE: "" }).bunCalls).toEqual(["run plan:production"]);
      expect(runStep(plan!, { FORCE: "yes" }).bunCalls).toEqual(["run plan:production --force"]);
      expect(runStep(plan!, { FORCE: "" }, 3).exitCode).not.toBe(0);
      expect(plan?.run).toContain(`> "$RUNNER_TEMP/plan/${s.key}.log" 2>&1`);
      expect(plan?.run).not.toContain("tee");
      expect(guard?.["working-directory"]).toBe(`${s.key}/infra`);
      expect(guard?.env).toEqual({ SCHEDULED: SCHEDULED_RUN });
      const guardedArgs = `^run plan:guard -- --log \\S+/plan/${s.key}\\.log --out \\S+/alchemy-plan/${s.key}\\.json --domains \\S+/domains-${s.key}\\.json`;
      const guarded = runStep(guard!, { SCHEDULED: "" }).bunCalls;
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toMatch(new RegExp(`${guardedArgs}$`));
      // GS5: a scheduled run tells the guard so, which refuses any added host.
      expect(runStep(guard!, { SCHEDULED: "yes" }).bunCalls[0]).toMatch(
        new RegExp(`${guardedArgs} --scheduled$`),
      );
      // The live custom domains the guard judges, read with the production pair.
      const domains = stepById(planJob, `worker_domains_${s.key}`);
      expect(domains?.if).toBe(when);
      expect(domains?.run).toBe(
        `bun run scripts/worker-deployments.ts domains "$RUNNER_TEMP/domains-${s.key}.json" --tier production ${productionSitesOf(s.key).join(" ")}`,
      );
      expect(domains?.env).toEqual(PRODUCTION_CREDENTIALS);
      const order = [
        at("token"),
        at("state"),
        at(`snapshot_${s.key}`),
        at(`worker_domains_${s.key}`),
        at(`plan_${s.key}`),
        at(`guard_${s.key}`),
      ];
      expect(order).toEqual(order.toSorted((a, b) => a - b));
    }
    const upload = steps.at(-1);
    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(upload?.with).toEqual({
      name: "alchemy-plan",
      path: "${{ runner.temp }}/alchemy-plan/",
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  });
});

describe("PW1: one production job per stack with a production deploy", () => {
  test("the stack jobs are the map's production stacks", () => {
    const ids = Object.keys(production.jobs).filter((id) => /^stack-[a-z]+-production$/.test(id));
    expect(ids.toSorted()).toEqual(PRODUCTION_STACKS.map((s) => s.production.id).toSorted());
    expect(PRODUCTION_STACKS.map((s) => s.key).toSorted()).toEqual(["cire", "musubi"]);
  });

  test.each(PRODUCTION_STACKS.map((s) => [s.key, s] as const))(
    "%s: named as the map says; PW-b runs only when the plan job and the sites job succeeded; production, alone in its group",
    (key, s) => {
      const job = productionStackJob(key);
      expect(job.name).toBe(s.production.name);
      expect(needsOf(job).toSorted()).toEqual(GATE_NEEDS);
      expect(job.if).toBe(
        `\${{ !cancelled() && needs.plan.outputs.stack_${key} == 'true' && needs.build.result == 'success' && needs.sites.result == 'success' && needs.alchemy-plan.result == 'success' }}`,
      );
      expect(environmentOf(job)).toBe("production");
      expect(job.concurrency).toEqual({
        group: `deploy-production-${key}`,
        "cancel-in-progress": false,
      });
      expect(job.env).toBeUndefined();
      expect(job.defaults).toBeUndefined();
    },
  );

  test.each(PRODUCTION_STACKS.map((s) => [s.key] as const))(
    "%s: state check, snapshot, then on every release re-plan and guard against the approved plan right before the deploy; then compare, a check per site and the verdict, in that order",
    (key) => {
      const job = productionStackJob(key);
      const sites = productionSitesOf(key);
      const steps = stepsOf(job);
      expect(stepById(job, "hosts")?.run).toBe("bun run --cwd shared/infra production-hosts");
      expect(stepById(job, "snapshot")?.run).toBe(
        `bun run scripts/worker-deployments.ts snapshot "$RUNNER_TEMP/deployments.json" --tier production ${sites.join(" ")}`,
      );
      const plan = stepById(job, "plan");
      const guard = stepById(job, "guard");
      const deploy = stepById(job, "deploy");
      const approved = steps.find((step) => step.with?.name === "alchemy-plan");
      expect(approved?.with).toEqual({ name: "alchemy-plan", path: "${{ runner.temp }}/approved" });
      // Nothing skips the re-plan or the guard, and nothing lets the deploy
      // run past a refusal.
      for (const step of [approved, plan, guard, deploy]) {
        expect({
          step: step?.name,
          if: step?.if,
          continues: step?.["continue-on-error"],
        }).toEqual({ step: step?.name, if: undefined, continues: undefined });
      }
      expect(plan?.["working-directory"]).toBe(`${key}/infra`);
      expect(runStep(plan!, { FORCE: "" }).bunCalls).toEqual(["run plan:production"]);
      expect(runStep(plan!, { FORCE: "yes" }).bunCalls).toEqual(["run plan:production --force"]);
      expect(runStep(plan!, { FORCE: "" }, 3).exitCode).not.toBe(0);
      expect(guard?.["working-directory"]).toBe(`${key}/infra`);
      expect(guard?.env).toEqual({ SCHEDULED: SCHEDULED_RUN });
      const guarded = `^run plan:guard -- --log \\S+/plan/${key}\\.log --out \\S+/plan-guard/${key}\\.json --domains \\S+/domains\\.json --approved \\S+/approved/${key}\\.json`;
      const plain = runStep(guard!, { SCHEDULED: "" }).bunCalls;
      expect(plain).toHaveLength(1);
      expect(plain[0]).toMatch(new RegExp(`${guarded}$`));
      // GS5: a scheduled run tells the guard so, which refuses any added host.
      expect(runStep(guard!, { SCHEDULED: "yes" }).bunCalls[0]).toMatch(
        new RegExp(`${guarded} --scheduled$`),
      );
      const domains = stepById(job, "worker_domains");
      expect(domains?.run).toBe(
        `bun run scripts/worker-deployments.ts domains "$RUNNER_TEMP/domains.json" --tier production ${sites.join(" ")}`,
      );
      expect(domains?.env).toEqual(PRODUCTION_CREDENTIALS);
      expect(domains?.if).toBeUndefined();
      // A refusal fails the guard step, which is the one right before the deploy.
      expect(runStep(guard!, {}, 1).exitCode).not.toBe(0);
      expect(stepIndex(job, "deploy")).toBe(stepIndex(job, "guard") + 1);
      expect(deploy?.["working-directory"]).toBe(`${key}/infra`);
      expect(deploy?.env).toEqual({
        FORCE: "${{ steps.snapshot.outputs.force == 'true' && 'yes' || '' }}",
        DO_NOT_TRACK: "1",
        OSN_DEPLOY_TIER: "production",
        ...PRODUCTION_CREDENTIALS,
      });
      expect(runStep(deploy!, { FORCE: "" }).bunCalls).toEqual(["run deploy:production"]);
      expect(runStep(deploy!, { FORCE: "yes" }).bunCalls).toEqual([
        "run deploy:production --force",
      ]);
      expect(runStep(deploy!, { FORCE: "" }, 3).exitCode).not.toBe(0);
      expect(plan?.env?.FORCE).toBe(deploy?.env?.FORCE);
      const compare = stepById(job, "deployments");
      expect(compare?.run).toBe(
        `bun run scripts/worker-deployments.ts compare "$RUNNER_TEMP/deployments.json" --tier production ${sites.join(" ")}`,
      );
      expect(compare?.if).toBe(ON_DEPLOY);
      expect(compare?.["continue-on-error"]).toBe(true);
      const order = [
        "hosts",
        "token",
        "state",
        "snapshot",
        "worker_domains",
        "plan",
        "guard",
        "deploy",
        "deployments",
        ...sites.map((site) => `smoke_${site}`),
      ].map((id) => stepIndex(job, id));
      expect(order.every((index) => index > -1)).toBe(true);
      expect(order).toEqual(order.toSorted((a, b) => a - b));
      expect(order.at(-1)).toBe(steps.length - 2);
      const install = steps.findIndex((step) => /\bbun install\b/.test(step.run ?? ""));
      expect(install).toBeLessThan(stepIndex(job, "token"));
    },
  );

  test.each(PRODUCTION_STACKS.map((s) => [s.key] as const))(
    "%s: PW9 each site's check runs after the deploy, never fails the job alone, and the last step fails it when any failed",
    (key) => {
      const job = productionStackJob(key);
      const sites = productionSitesOf(key);
      for (const site of sites) {
        const smoke = stepById(job, `smoke_${site}`);
        expect(smoke?.run).toBe(`bun run scripts/smoke-check.ts ${site} production`);
        expect(smoke?.if).toBe(ON_DEPLOY);
        expect(smoke?.["continue-on-error"]).toBe(true);
        // Room for the check, the rollback and its re-check
        // (scripts/tests/smoke-check.test.ts, SB4).
        expect(smoke?.["timeout-minutes"]).toBe(5);
        expect(smoke?.env).toEqual({
          SMOKE_ORIGIN: `\${{ steps.hosts.outputs.${site}_origin }}`,
          SMOKE_DEPLOYMENT: `\${{ steps.deployments.outputs.${site}_deployment }}`,
          ...PRODUCTION_CREDENTIALS,
        });
        expect(productionSiteTarget(site)).toBeDefined();
      }
      const failed = [
        "steps.deployments.outcome == 'failure'",
        ...sites.map((site) => `steps.smoke_${site}.outcome == 'failure'`),
      ];
      const last = stepsOf(job).at(-1);
      expect(last?.if).toBe(`\${{ !cancelled() && (${failed.join(" || ")}) }}`);
      expect(last?.run).toContain("exit 1");
      expect(job.outputs).toEqual({
        deployed:
          "${{ steps.deploy.outcome == 'success' && steps.deployments.outcome == 'success' }}",
        ...Object.fromEntries(
          sites.map((site) => [
            `${site}_healthy`,
            `\${{ steps.smoke_${site}.outcome == 'success' }}`,
          ]),
        ),
      });
    },
  );
});

describe("PW6: one record job per site its Worker serves", () => {
  test.each(recordSurfaces.map((s) => [s.key, s] as const))(
    "%s: named as the map says, in production-records, needs only its stack job and runs when its check passed",
    (key, s) => {
      const job = production.jobs[s.production.id]!;
      const stackJob = PRODUCTION_STACKS.find((x) => x.key === s.stack)?.production.id ?? "";
      expect(job.name).toBe(s.production.name);
      expect(environmentOf(job)).toBe("production-records");
      expect(needsOf(job)).toEqual([stackJob]);
      expect(job.if).toBe(
        `\${{ !cancelled() && needs.${stackJob}.outputs.deployed == 'true' && needs.${stackJob}.outputs.${key}_healthy == 'true' }}`,
      );
      expect(stepsOf(job).some((step) => step.uses !== undefined)).toBe(false);
      expect(JSON.stringify(job)).not.toContain("secrets.");
    },
  );
});

describe("PW-A: a job that holds a credential lets in only the site builds of the sites job's artifact", () => {
  const PLACE = 'bun run scripts/production-sites-artifact.ts "$RUNNER_TEMP/production-sites"';
  const downloads = Object.entries(production.jobs).flatMap(([id, job]) =>
    stepsOf(job).flatMap((step, at) =>
      step.uses === "actions/download-artifact@v4" && step.with?.name === "production-sites"
        ? [{ id, job, at }]
        : [],
    ),
  );

  test("every job that fetches the builds: alchemy-plan and the stack jobs", () => {
    expect(downloads.map(({ id }) => id).toSorted()).toEqual(
      ["alchemy-plan", ...PRODUCTION_STACKS.map((s) => s.production.id)].toSorted(),
    );
  });

  test.each(downloads.map(({ id, job, at }) => [id, job, at] as const))(
    "%s: downloads outside the checkout, and the next step, holding no secret, checks it before anything else runs",
    (_, job, at) => {
      const steps = stepsOf(job);
      expect(steps[at]?.with?.path).toBe("${{ runner.temp }}/production-sites");
      const place = steps[at + 1];
      expect(place?.run).toBe(PLACE);
      expect(place?.env).toBeUndefined();
      expect(place?.if).toBeUndefined();
      expect(place?.["continue-on-error"]).toBeUndefined();
      expect(place?.["working-directory"]).toBeUndefined();
      expect(job.env).toBeUndefined();
    },
  );
});

describe("PW-D: a job that holds a credential and installs a narrower tree than the sites job restores no dependency cache", () => {
  // Jobs holding no secret write the shared cache; a narrower tree would
  // take from it packages its own install never fetched.
  const narrow = ["alchemy-plan", ...PRODUCTION_STACKS.map((s) => s.production.id)];

  test.each(narrow.map((id) => [id] as const))("%s", (id) => {
    const job = production.jobs[id]!;
    expect(stepsOf(job).filter((step) => step.with?.path === "~/.bun/install/cache")).toEqual([]);
  });
});

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/**
 * The workspaces whose build runs the cire CSP integration (`tierHeaders`):
 * every one that depends on `@cire/build-tools`, by name, sorted.
 */
function tierHeadersPackages(): string[] {
  const readJson = <T>(path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
  return readJson<{ workspaces: string[] }>("package.json")
    .workspaces.flatMap((pattern) =>
      Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })),
    )
    .map((path) => readJson<Manifest>(path))
    .filter((pkg) => "@cire/build-tools" in { ...pkg.dependencies, ...pkg.devDependencies })
    .map((pkg) => pkg.name)
    .toSorted();
}

describe("every deploy build of a cire site that retargets its CSP names its tier", () => {
  // The CSP integration checks the cire-api origin of a build that sets
  // OSN_DEPLOY_TIER: never on this machine, and on production the production
  // API. Each deploy build of these sites sets the tier as a literal, so the
  // workflow fixes its value. The CI test builds (`bun run build`, no filter)
  // set none, and must not.
  const packages = tierHeadersPackages();

  test("some workspace runs the integration", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  test.each([
    [WORKFLOW_FILE.dev, dev, "dev"],
    [WORKFLOW_FILE.production, production, "production"],
  ] as const)("%s builds each of them once, as a deploy to its tier", (_, workflow, tier) => {
    const builtPackage = (step: Step) => BUILD.exec(step.run ?? "")?.[1] ?? "";
    const builds = Object.values(workflow.jobs)
      .flatMap((job) => buildsOf(job))
      .filter((step) => packages.includes(builtPackage(step)));
    expect(builds.map(builtPackage).toSorted()).toEqual(packages);
    for (const step of builds) expect(step.env?.OSN_DEPLOY_TIER).toBe(tier);
  });
});

const ownJobSurfaces = PRODUCTION_SURFACES.filter((s) => s.production.kind === "job");
const recordSurfaces = PRODUCTION_SURFACES.filter((s) => s.production.kind === "stack");
const surface = (key: SurfaceKey): Surface => SURFACES.find((s) => s.key === key)!;

/** The environment variables a check's probes send as bearers, once each. */
const bearersOf = (probes: readonly Probe[]): string[] => [
  ...new Set(probes.flatMap((probe) => (probe.bearer === undefined ? [] : [probe.bearer]))),
];

describe("every Worker deploy is smoke-checked, and rolls back the Worker it deployed", () => {
  const SMOKE_STEP = "Smoke check, rolling back on failure";
  /** Every surface with a dev target, in SMOKE_TARGETS order. */
  const devSmokeKeys = (Object.keys(SMOKE_TARGETS) as SurfaceKey[]).filter(
    (key) => devTarget(key) !== undefined,
  );
  const productionTargets = PRODUCTION_SURFACES.flatMap((s) => {
    const target = productionTarget(s.key);
    return target === undefined ? [] : [[`${s.key} production`, s.key, target] as const];
  });
  const productionJobOf = (key: SurfaceKey) => {
    const job = PRODUCTION_SURFACES.find((s) => s.key === key)?.production;
    if (job === undefined) throw new Error(`${key} has no production job`);
    return job.id;
  };

  test("production: the jobs that run `wrangler deploy` are exactly the smoke targets' jobs", () => {
    const deploying = Object.entries(production.jobs)
      .filter(([, job]) => stepsOf(job).some((s) => /\bwrangler deploy\b/.test(s.run ?? "")))
      .map(([id]) => id);
    expect(deploying.toSorted()).toEqual(
      productionTargets.map(([, key]) => productionJobOf(key)).toSorted(),
    );
  });

  test("dev: each stack job checks every dev surface of its stack once, and no other job checks any", () => {
    const checked = (job: Job) =>
      stepsOf(job).flatMap((step) => {
        const match = /^bun run scripts\/smoke-check\.ts (\S+) (\S+)$/.exec(step.run ?? "");
        return match === null ? [] : [`${match[1]} ${match[2]}`];
      });
    for (const s of STACKS) {
      expect(checked(stackJobOf(s.key))).toEqual(surfacesOf(s.key).map((x) => `${x.key} dev`));
    }
    const elsewhere = Object.entries(dev.jobs)
      .filter(([id]) => !STACKS.some((s) => s.job.id === id))
      .flatMap(([, job]) => checked(job));
    expect(elsewhere).toEqual([]);
    expect(STACKS.flatMap((s) => checked(stackJobOf(s.key))).toSorted()).toEqual(
      devSmokeKeys.map((key) => `${key} dev`).toSorted(),
    );
  });

  test.each(productionTargets)("%s", (_, key, target) => {
    const job = production.jobs[productionJobOf(key)]!;
    expect(environmentOf(job)).toBe("production");
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
    expect(smoke?.run).toBe(`bun run scripts/smoke-check.ts ${key} production`);
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
    expect(production.defaults).toBeUndefined();

    const env = smoke?.env ?? {};
    expect(env.WRANGLER_OUTPUT_FILE_PATH).toBe(output);
    if (target.access === true) {
      expect(env.CF_ACCESS_CLIENT_ID).toBe("${{ secrets.CF_ACCESS_CLIENT_ID }}");
      expect(env.CF_ACCESS_CLIENT_SECRET).toBe("${{ secrets.CF_ACCESS_CLIENT_SECRET }}");
    } else {
      expect(Object.keys(env).filter((name) => name.startsWith("CF_ACCESS"))).toEqual([]);
    }
    // A probe's bearer comes from the Environment, under its own name; a
    // check whose probes send none is given none.
    const bearerNames: string[] = Object.keys(env).filter(
      (name) => name === "INTERNAL_SERVICE_SECRET",
    );
    expect(bearerNames).toEqual(bearersOf(target.probes));
    for (const name of bearersOf(target.probes)) {
      expect(env[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  test.each(SURFACES.map((s) => [`${s.key} dev`, s] as const))("%s", (_, s) => {
    const target = devTarget(s.key)!;
    const job = stackJobOf(s.stack);
    expect(environmentOf(job)).toBe("dev");
    const smoke = stepById(job, `smoke_${s.key}`);
    expect(smoke?.name).toBe(`Smoke check ${displayName(s)}, rolling back on failure`);
    expect(smoke?.run).toBe(`bun run scripts/smoke-check.ts ${s.key} dev`);
    expect(smoke?.["working-directory"]).toBeUndefined();
    // A deploy that failed part-way still checks, and rolls back, what it
    // managed to upload; a Worker the compare could not read is checked
    // without rollback.
    expect(smoke?.if).toBe(ON_SNAPSHOT);
    expect(smoke?.["timeout-minutes"]).toBe(5);
    // The job's last step turns a failed check into a failed job, after every
    // other surface of the stack has been checked.
    expect(smoke?.["continue-on-error"]).toBe(true);

    const expected: Record<string, string> = {
      SMOKE_ORIGIN: hostOutput(DEV_HOST_OUTPUT[s.key]),
      SMOKE_DEPLOYMENT: `\${{ steps.deployments.outputs.${s.key}_deployment }}`,
      ...DEV_CREDENTIALS,
    };
    if (target.needsMarketing) expected.SMOKE_MARKETING_ORIGIN = hostOutput("cire_landing_origin");
    if (target.access) {
      expected.CF_ACCESS_CLIENT_ID = "${{ secrets.CF_ACCESS_CLIENT_ID }}";
      expected.CF_ACCESS_CLIENT_SECRET = "${{ secrets.CF_ACCESS_CLIENT_SECRET }}";
    }
    const probes = target.probes({ origin: "https://a.example.test", marketing: "https://b.test" });
    for (const name of bearersOf(probes)) expected[name] = `\${{ secrets.${name} }}`;
    expect(smoke?.env).toEqual(expected);
  });
});

/** The narrower installs only production-release.yml runs: an Alchemy job's own stack trees. */
const PRODUCTION_ONLY_INSTALLS = [
  "bun install --frozen-lockfile --filter @cire/infra --filter @musubi/infra",
  "bun install --frozen-lockfile --filter @cire/infra",
  "bun install --frozen-lockfile --filter @musubi/infra",
];

describe("installs", () => {
  test.each([WORKFLOW_FILE.dev, WORKFLOW_FILE.production])(
    "%s installs from the lockfile and never rewrites it",
    (path) => {
      const installs = Object.values(load(path).jobs)
        .flatMap((job) => stepsOf(job))
        .filter((step) => /\bbun install\b/.test(step.run ?? ""));
      expect(installs.length).toBeGreaterThan(0);
      for (const step of installs) {
        // The filtered form leaves out every `@<product>/infra` workspace:
        // each depends on Alchemy, so leaving out @shared/infra alone still
        // installs the Alchemy tree through the stacks.
        expect([
          "bun install --frozen-lockfile",
          "bun install --frozen-lockfile --filter '!@*/infra'",
          ...(path === WORKFLOW_FILE.production ? PRODUCTION_ONLY_INSTALLS : []),
        ]).toContain(step.run ?? "");
      }
    },
  );

  test("ci.yml's filtered installs leave out the infra packages, in the same form", () => {
    const filtered = Object.values(load(".github/workflows/ci.yml").jobs)
      .flatMap((job) => stepsOf(job))
      .map((step) => step.run ?? "")
      .filter((run) => /\bbun install\b/.test(run) && run.includes("--filter"));
    expect(filtered.length).toBeGreaterThan(0);
    for (const run of filtered) {
      expect(run).toMatch(/^bun install (--frozen-lockfile )?--filter '!@\*\/infra'$/);
    }
  });

  // actions/cache saves a key once, from the first job that misses it. A
  // filtered install that saved the key a full install restores would leave
  // every full install fetching what the filter left out (the Alchemy tree,
  // over 1 GB unpacked), so each install form saves under its own key.
  test("in every workflow, bun's cache is keyed on what the job installs", () => {
    const lock = "${{ hashFiles('bun.lock') }}";
    /** The key prefix for each `--filter` an install passes; no filter is a full install. */
    const PREFIX: Readonly<Record<string, string>> = {
      "": "bun",
      "'!@*/infra'": "bun-noinfra",
      "@shared/infra": "bun-shared-infra",
    };
    const files = readdirSync(join(root, ".github/workflows")).filter((file) =>
      /\.ya?ml$/.test(file),
    );
    const cached = files.flatMap((file) =>
      Object.entries(load(`.github/workflows/${file}`).jobs).flatMap(([id, job]) => {
        const caches = stepsOf(job).filter((step) => step.with?.path === "~/.bun/install/cache");
        if (caches.length === 0) return [];
        const installs = stepsOf(job)
          .map((step) => step.run ?? "")
          .filter((run) => /\bbun install\b/.test(run));
        return [{ job: `${file} ${id}`, caches, installs }];
      }),
    );
    expect(cached.length).toBeGreaterThan(0);
    for (const { job, caches, installs } of cached) {
      expect({ job, caches: caches.length, installs: installs.length }).toEqual({
        job,
        caches: 1,
        installs: 1,
      });
      const filter = /--filter (.+)$/.exec(installs[0] ?? "")?.[1] ?? "";
      const prefix = PREFIX[filter];
      expect({ job, filter, known: prefix !== undefined }).toEqual({ job, filter, known: true });
      // A restore-only step saves nothing, so it may share any key it reads.
      expect(["actions/cache@v4", "actions/cache/restore@v4"]).toContain(caches[0]?.uses ?? "");
      expect({ job, with: caches[0]?.with }).toEqual({
        job,
        with: {
          path: "~/.bun/install/cache",
          key: `\${{ runner.os }}-${prefix}-${lock}`,
          "restore-keys": `\${{ runner.os }}-${prefix}-\n`,
        },
      });
    }
  });

  // The probe needs only the dev-hosts command, which runs from
  // @shared/infra; the probe itself imports no package.
  test("the cire latency probe installs only @shared/infra, cached, and runs the probe without installing", () => {
    const steps = stepsOf(load(".github/workflows/cire-d1-latency-probe.yml").jobs.probe);
    const installs = steps.filter((step) => /\bbun install\b/.test(step.run ?? ""));
    expect(installs.map((step) => step.run)).toEqual([
      "bun install --frozen-lockfile --filter @shared/infra",
    ]);
    const cache = steps.findIndex((step) => step.with?.path === "~/.bun/install/cache");
    const install = steps.indexOf(installs[0]!);
    expect(cache).toBeGreaterThan(-1);
    expect(cache).toBeLessThan(install);
    expect(install).toBeLessThan(steps.findIndex((step) => step.id === "hosts"));
    expect(
      steps.filter((step) => step.run?.includes("d1-latency-probe.ts")).map((step) => step.run),
    ).toEqual(["bun --no-install cire/api/scripts/d1-latency-probe.ts"]);
  });

  test("'!@*/infra' leaves out every workspace that depends on alchemy or an @alchemy.run package", () => {
    // The filtered installs exist to keep the Alchemy tree out; a workspace
    // that depends on it under any other name would bring the tree back.
    const patterns = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces: string[] }
    ).workspaces;
    const manifests = patterns.flatMap((pattern) =>
      Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })),
    );
    const onAlchemy = manifests
      .map(
        (path) =>
          JSON.parse(readFileSync(join(root, path), "utf8")) as {
            name: string;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          },
      )
      .filter((manifest) =>
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).some(
          (name) => name === "alchemy" || name.startsWith("@alchemy.run/"),
        ),
      )
      .map((manifest) => manifest.name);
    expect(onAlchemy.length).toBeGreaterThan(0);
    const infra = new Bun.Glob("@*/infra");
    expect(onAlchemy.filter((name) => !infra.match(name))).toEqual([]);
  });
});

describe("every other workflow", () => {
  const otherWorkflows = () => {
    const owners = new Set<string>([WORKFLOW_FILE.dev, WORKFLOW_FILE.production]);
    return readdirSync(join(root, ".github/workflows"))
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .map((file) => `.github/workflows/${file}`)
      .filter((path) => !owners.has(path));
  };

  // A Worker deployed from anywhere else skips the smoke check, and the planner
  // never sees it. This reads Wrangler deploys alone: an Alchemy deploy does
  // not show here.
  test("deploys no Worker", () => {
    for (const path of otherWorkflows()) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).not.toMatch(/\bwrangler (versions )?deploy\b|cloudflare\/wrangler-action/);
    }
  });

  // A newer job in a concurrency group cancels the one pending there, which
  // can be a production deploy waiting for its approval, so no other
  // workflow, dev's included, joins a production deploy group.
  test("takes no production deploy group, nor does deploy.yml", () => {
    const paths = [...otherWorkflows(), WORKFLOW_FILE.dev];
    for (const path of paths) {
      const workflow = load(path);
      const groups = [
        workflow.concurrency,
        ...Object.values(workflow.jobs ?? {}).map((job) => job.concurrency),
      ].flatMap((concurrency) => (concurrency === undefined ? [] : [String(concurrency.group)]));
      expect({
        path,
        groups: groups.filter((group) => group.startsWith("deploy-production-")),
      }).toEqual({
        path,
        groups: [],
      });
    }
  });

  // The planner ties a Deployment record to a surface by its job's name, and
  // counts only records from runs of the two deploy workflows. A job of the
  // same name anywhere else is a deploy the planner cannot see.
  test("uses none of the map's job names", () => {
    const names = new Set([
      ...SURFACES.flatMap((s) => (s.production ? [s.production.name, s.dev.name] : [s.dev.name])),
      ...STACKS.flatMap((s) => (s.production ? [s.job.name, s.production.name] : [s.job.name])),
    ]);
    const others = otherWorkflows();
    expect(others.length).toBeGreaterThan(0);
    for (const path of others) {
      const jobs = Object.values(load(path).jobs ?? {});
      for (const job of jobs) expect(names.has(job.name ?? "")).toBe(false);
    }
  });
});
