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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  PREBUILT_WORKER_BUILDS,
  SITE_BUILDS,
  SITE_SURFACES,
  type SiteSurface,
} from "../../shared/infra/src/production-sites";
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
import { devTarget, type Probe, productionTarget, SMOKE_TARGETS } from "../smoke-check";

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
  readonly "continue-on-error"?: boolean | string;
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

/**
 * Runs a `chromium-apt-key` step's script as GitHub runs it (`bash -e`), on a
 * runner whose image values default to Ubuntu 26.04's and override with
 * `image`, with a stand-in `bunx` that prints `version` for
 * `playwright --version`. Returns the lines it wrote to $GITHUB_OUTPUT.
 */
function runChromiumAptKey(
  step: Step | undefined,
  image: Readonly<Record<string, string>>,
  version = "Version 1.64.1\n",
): { readonly exitCode: number; readonly stdout: string; readonly outputs: readonly string[] } {
  const dir = mkdtempSync(join(tmpdir(), "chromium-apt-key-"));
  try {
    writeFileSync(join(dir, "version"), version);
    writeFileSync(join(dir, "bunx"), `#!/bin/sh\ncat "${join(dir, "version")}"\n`);
    chmodSync(join(dir, "bunx"), 0o755);
    const outputs = join(dir, "outputs");
    writeFileSync(outputs, "");
    const result = Bun.spawnSync(
      ["bash", "--noprofile", "--norc", "-e", "-c", step?.run ?? "exit 9"],
      {
        cwd: dir,
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          GITHUB_OUTPUT: outputs,
          RUNNER_OS: "Linux",
          ImageOS: "ubuntu26",
          ImageVersion: "20261111.82.6",
          ...image,
        },
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      outputs: readFileSync(outputs, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// A test runs again only when its run failed, and then as a whole run on new
// processes, never inside the page it failed in. A step that runs the tier
// plain lets one flaky test drop a pull request from the merge queue; a step
// that repeats tests that passed doubles the tier on every run.
describe("PR3: ci.yml runs the scripts and browser tiers once, and the whole tier once more only when it fails, on every event", () => {
  const ci = load(".github/workflows/ci.yml");
  // retry.sh's default grace, and its wait for an attempt's processes to go.
  const PER_RUN_EXTRA = 10 + 10;

  /** The lines a step runs, with comments and blank lines left out. */
  const linesOf = (step: Step | undefined): string[] =>
    (step?.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  /**
   * The one step of the job whose run matches `runs`: its command must be
   * `wrapped`, on no condition, with room in the step for two runs at their
   * limit and room in the job for the step.
   */
  const throughTheWrapper = (id: string, runs: RegExp, wrapped: string) => {
    const job = ci.jobs[id];
    const steps = stepsOf(job).filter((step) => linesOf(step).some((line) => runs.test(line)));
    expect(steps.map((step) => step.name)).toHaveLength(1);
    const step = steps[0];
    expect(linesOf(step)).toEqual([wrapped]);
    const [attempts, seconds] = /^bash scripts\/test-with-retry\.sh (\d+) (\d+) /
      .exec(wrapped)
      ?.slice(1)
      .map(Number) ?? [0, 0];
    expect(attempts).toBe(2);
    expect({ if: step?.if, "continue-on-error": step?.["continue-on-error"] }).toEqual({
      if: undefined,
      "continue-on-error": undefined,
    });
    expect(job?.if ?? "").not.toContain("event_name");
    const stepMinutes = step?.["timeout-minutes"] ?? 0;
    expect(stepMinutes * 60).toBeGreaterThanOrEqual(attempts * (seconds + PER_RUN_EXTRA));
    // The job holds every step's limit, so the step's own limit, not the
    // job's, cuts a run.
    const limits = stepsOf(job).reduce((sum, one) => sum + (one["timeout-minutes"] ?? 0), 0);
    expect(job?.["timeout-minutes"] ?? 0).toBeGreaterThan(id === "browser" ? stepMinutes : limits);
  };

  test("the Scripts job runs `bun run test:scripts` through test-with-retry.sh, at most two runs of five minutes", () => {
    throughTheWrapper(
      "script-tests",
      /\bbun run test:scripts(\s|$)/,
      "bash scripts/test-with-retry.sh 2 300 Scripts bun run test:scripts",
    );
  });

  // `--force` would run every package again, and turbo's cache is how only
  // the failed package runs on the second run.
  test("each browser leg runs its turbo `test:browser` through test-with-retry.sh, at most two runs of ten minutes, with no `--force`", () => {
    throughTheWrapper(
      "browser",
      /\bturbo run test:browser\b(?!.*--dry)/,
      'bash scripts/test-with-retry.sh 2 600 "Browser tests ($LEG)" bunx --no-install turbo run test:browser $FILTERS --continue --concurrency=1 --cache-dir=.turbo/browser',
    );
  });

  test("the E2E step keeps its own wrapper, which sets the failed run's artifacts aside, and does not go through test-with-retry.sh", () => {
    const steps = stepsOf(ci.jobs.e2e);
    expect(steps.filter((step) => step.run?.includes("e2e-with-retry.sh"))).toHaveLength(1);
    expect(steps.filter((step) => step.run?.includes("test-with-retry.sh"))).toEqual([]);
  });

  test("no step in any workflow runs a test again after it passed: none carries --rerun-each, --repeats or --randomize", () => {
    const workflows = Array.from(
      new Bun.Glob(".github/workflows/*.yml").scanSync({ cwd: root }),
    ).toSorted();
    expect(workflows).toContain(".github/workflows/ci.yml");
    const repeating = workflows.flatMap((path) =>
      Object.entries(load(path).jobs).flatMap(([id, job]) =>
        stepsOf(job)
          .filter((step) => /--rerun-each|--repeats|--randomize/.test(step.run ?? ""))
          .map((step) => `${path} ${id}: ${step.name}`),
      ),
    );
    expect(repeating).toEqual([]);
  });
});

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

  // A job missing from `needs` can be red while the merge goes through. Without
  // `always()` a failed need skips the gate, and GitHub counts a skipped
  // required check as passed.
  test("the gate needs every job, E2E included, and runs whatever its needs did", () => {
    const gated = Object.keys(ci.jobs)
      .filter((id) => id !== "ci")
      .toSorted();
    expect(needs.toSorted()).toEqual(gated);
    expect(ci.jobs.ci?.if).toBe("always()");
  });

  /**
   * Runs the gate's script as GitHub runs it, each
   * `${{ contains(needs.*.result, '<result>') }}` replaced by its value when
   * the needs ended as `results` says. Any other expression in the script
   * throws, so a rewritten script fails here rather than passing unread.
   */
  const gate = (results: Readonly<Record<string, string>>) => {
    const step = stepsOf(ci.jobs.ci).find((one) => one.name === "Check results");
    const ended = Object.values(results);
    const script = (step?.run ?? "exit 9").replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => {
      const match = /^\s*contains\(needs\.\*\.result, '([a-z]+)'\)\s*$/.exec(expression);
      if (match === null) throw new Error(`the gate's script holds ${expression}`);
      return String(ended.includes(match[1] ?? ""));
    });
    return Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", script]).exitCode;
  };

  // A need is skipped in the merge queue and on a push to main (E2E), and on
  // a prose-only change (every job that waits on the detection); a skip that
  // failed the gate would hold every queue group and prose change for good.
  // A need is cancelled when a newer push supersedes its run.
  test("a skipped need passes the gate, and a failed or cancelled one fails it", () => {
    const passed = Object.fromEntries(needs.map((id) => [id, "success"]));
    const onProse = needs.filter((id) => needsOf(ci.jobs[id] ?? {}).includes("changes"));
    expect(onProse).toContain("e2e");
    expect(gate(passed)).toBe(0);
    expect(gate({ ...passed, e2e: "skipped" })).toBe(0);
    expect(gate({ ...passed, ...Object.fromEntries(onProse.map((id) => [id, "skipped"])) })).toBe(
      0,
    );
    for (const id of needs) {
      for (const result of ["failure", "cancelled"]) {
        expect({ id, result, exit: gate({ ...passed, [id]: result }) }).toEqual({
          id,
          result,
          exit: 1,
        });
      }
    }
  });

  // `continue-on-error` reports a failed job, or a failed step, as passed to
  // whatever reads its result, the gate included. A cache save is the one
  // exception: it only writes a cache, and a save that hangs or fails must not
  // turn a leg red.
  test("no job the gate needs, and no step in one but a cache save, carries continue-on-error", () => {
    for (const id of needs) {
      const job = ci.jobs[id];
      expect({ id, "continue-on-error": job?.["continue-on-error"] }).toEqual({
        id,
        "continue-on-error": undefined,
      });
      for (const step of stepsOf(job).filter((one) => one.uses !== "actions/cache/save@v4")) {
        const name = step.name ?? step.uses;
        expect({ id, name, "continue-on-error": step["continue-on-error"] }).toEqual({
          id,
          name,
          "continue-on-error": undefined,
        });
      }
    }
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
  // can restore from, so a cache saved there is space and nothing else. Each
  // save names the event first, as not a queue group or as a push; it may add
  // conditions of its own after that, joined by `&&`. This checks the separate
  // save steps only; an `actions/cache` step saves in its post step, which no
  // `if` here reaches.
  test("no actions/cache/save step runs on a merge-queue run", () => {
    const saves = Object.values(ci.jobs)
      .flatMap((job) => stepsOf(job))
      .filter((step) => step.uses === "actions/cache/save@v4");
    expect(saves.length).toBeGreaterThan(0);
    for (const step of saves) {
      expect({ path: step.with?.path, if: step.if }).toEqual({
        path: step.with?.path,
        if: expect.stringMatching(/^github\.event_name (!= 'merge_group'|== 'push')( && [^|]+)?$/),
      });
    }
  });

  // No E2E job runs on a push to main, so a browser leg saves main's copy of
  // both Chromium caches there, the copy every pull request and queue group
  // restores; without it each pull request's E2E saves a ~290 MB browser of its
  // own. One leg saves, so three legs do not race for one key. Each save
  // follows its install and comes before the tests, so a red leg still saves.
  test("on a push to main, one browser leg saves each Chromium cache it restored, straight after its install and before the tests, and a failed save fails nothing", () => {
    const steps = stepsOf(ci.jobs.browser);
    const at = (found: (step: Step) => boolean) => steps.findIndex(found);
    const tests = at((step) => step.name === "Browser tests");
    for (const [path, id, install] of [
      ["~/.cache/ms-playwright", "chromium", "Install Chromium for browser tests"],
      ["~/.cache/chromium-apt", "chromium-apt", "Install Chromium's system libraries"],
    ] as const) {
      const restore = at(
        (step) => step.uses === "actions/cache/restore@v4" && step.with?.path === path,
      );
      const save = at((step) => step.uses === "actions/cache/save@v4" && step.with?.path === path);
      const installed = at((step) => step.name === install);
      expect({
        path,
        restore: steps[restore]?.id,
        if: steps[save]?.if,
        key: steps[save]?.with?.key,
        "timeout-minutes": steps[save]?.["timeout-minutes"],
        "continue-on-error": steps[save]?.["continue-on-error"],
      }).toEqual({
        path,
        restore: id,
        if: `github.event_name == 'push' && strategy.job-index == 0 && steps.${id}.outputs.cache-hit != 'true'`,
        key: `\${{ steps.${id}.outputs.cache-primary-key }}`,
        "timeout-minutes": 5,
        "continue-on-error": true,
      });
      expect(installed).toBeGreaterThan(restore);
      expect(save).toBe(installed + 1);
      expect(tests).toBeGreaterThan(save);
    }
  });

  // GitHub runs ubuntu-latest on several image builds at once (`20261111.82.6`
  // on AWS runners beside `20261111.196.1` on Azure ones, 2026-11-19), each
  // installing the same packages, and evicts a set within hours once no run
  // reads it. A restore that matched only its own build's key would find
  // nothing on a build no recent run on main saved, and apt would download
  // every package from the mirror. So each restore falls back to the newest
  // set saved for any build of the same OS image, in the run's own branch
  // first and then in main's; scripts/install-chromium-system-libraries.sh
  // still moves into apt's archive only the packages the runner's own signed
  // index names (install-chromium-system-libraries.cli.test.ts), so a set
  // saved on another build changes how much apt downloads, never what it
  // installs. Each job that saves writes its own build's exact key.
  test("Chromium's system packages are saved under the image build's own key and restored from any build of the same OS image, both keys built the same way by the browser legs and the E2E job", () => {
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
        fallback: "${{ steps.chromium-apt-key.outputs.prefix }}",
      },
      {
        id: "browser",
        uses: "actions/cache/save@v4",
        key: "${{ steps.chromium-apt.outputs.cache-primary-key }}",
        fallback: undefined,
      },
      {
        id: "e2e",
        uses: "actions/cache/restore@v4",
        key: "${{ steps.chromium-apt-key.outputs.key }}",
        fallback: "${{ steps.chromium-apt-key.outputs.prefix }}",
      },
      {
        id: "e2e",
        uses: "actions/cache/save@v4",
        key: "${{ steps.chromium-apt.outputs.cache-primary-key }}",
        fallback: undefined,
      },
    ]);
    const keyStep = (id: string) =>
      stepsOf(ci.jobs[id]).find((step) => step.id === "chromium-apt-key");
    expect(keyStep("e2e")?.run).toBe(keyStep("browser")?.run);

    const aws = runChromiumAptKey(keyStep("browser"), { ImageVersion: "20261111.82.6" });
    const azure = runChromiumAptKey(keyStep("browser"), { ImageVersion: "20261111.196.1" });
    expect([aws.exitCode, azure.exitCode]).toEqual([0, 0]);
    expect(aws.outputs).toEqual([
      "key=Linux-chromium-apt-ubuntu26-20261111.82.6-playwright-1.64.1",
      "prefix=Linux-chromium-apt-ubuntu26-",
    ]);
    // A run on one build restores the set the other saved.
    const value = (outputs: readonly string[], name: string) =>
      outputs.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? "-";
    expect(value(azure.outputs, "key").startsWith(value(aws.outputs, "prefix"))).toBe(true);
    expect(value(aws.outputs, "key").startsWith(value(azure.outputs, "prefix"))).toBe(true);
  });

  // A key with no Playwright version would be restored across versions, and a
  // value holding a newline would write an output line of its own.
  test("the system packages' key step fails when Playwright prints no version, and writes only one line of [A-Za-z0-9._-] per output whatever the runner's values hold", () => {
    const keyStep = stepsOf(ci.jobs.browser).find((step) => step.id === "chromium-apt-key");
    const unversioned = runChromiumAptKey(keyStep, {}, "Version \n");
    expect(unversioned.exitCode).toBe(1);
    expect(unversioned.stdout).toContain(
      "::error::playwright --version printed no 'Version <n>' line",
    );
    expect(unversioned.outputs).toEqual([]);

    const forged = runChromiumAptKey(keyStep, {
      ImageOS: "ubuntu26\nkey=x",
      ImageVersion: "1 2\nprefix=y",
    });
    expect(forged.exitCode).toBe(0);
    expect(forged.outputs.map((line) => line.slice(0, line.indexOf("=")))).toEqual([
      "key",
      "prefix",
    ]);
    for (const line of forged.outputs) {
      expect(line.slice(line.indexOf("=") + 1)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
    const [key = "", prefix = "-"] = forged.outputs.map((line) =>
      line.slice(line.indexOf("=") + 1),
    );
    expect(key.startsWith(prefix)).toBe(true);
  });

  // scripts/install-chromium-system-libraries.sh at its longest: three
  // attempts each cut at their limit, with retry.sh's grace and its wait for
  // an attempt's processes to go, then the dry run with its own grace. Each
  // wait for dpkg's lock sits inside an attempt, so it must be shorter than
  // one; a longer one would always be cut before it gave up.
  test("Chromium's system-library install, its waits for dpkg's lock included, ends inside the limit each job gives its step", () => {
    const read = (path: string) => readFileSync(join(root, path), "utf8");
    const numbers = (text: string, pattern: RegExp) =>
      (pattern.exec(text)?.slice(1) ?? []).map(Number);
    const script = read("scripts/install-chromium-system-libraries.sh");
    // No `-k`: the attempts take retry.sh's default grace.
    const [attempts = 0, seconds = 0] = numbers(script, /retry\.sh" (\d+) (\d+) \\$/m);
    const [lockWait = Number.NaN] = numbers(script, /^lock_wait=(\d+)$/m);
    const [dryGrace = 0, dryLimit = 0] = numbers(
      script,
      /timeout -k (\d+) (\d+) bunx --no-install playwright install-deps --dry-run chromium/,
    );
    const retry = read("scripts/retry.sh");
    const [grace = Number.NaN] = numbers(retry, /^grace=(\d+)$/m);
    // The wait for an attempt's processes: up to <polls> checks, <pause> s apart.
    const [polls = Number.NaN, pause = Number.NaN] = numbers(
      retry,
      /for _ in \$\(seq 1 (\d+)\); do\n.*\n\s+sleep ([\d.]+)\n/,
    );
    expect(attempts).toBeGreaterThan(0);
    expect(dryLimit).toBeGreaterThan(0);
    expect(lockWait).toBeLessThan(seconds);
    const longest = attempts * (seconds + grace + polls * pause) + dryLimit + dryGrace;
    // The figure the script's header and wiki/conventions/browser-tests.md state.
    expect(longest).toBeCloseTo(580);

    const limits = Object.entries(ci.jobs).flatMap(([id, job]) =>
      stepsOf(job)
        .filter((step) => step.name === "Install Chromium's system libraries")
        .map((step) => {
          const minutes = /^timeout (\d+)m /.exec(step.run ?? "")?.[1];
          return { id, seconds: 60 * Number(step["timeout-minutes"] ?? minutes ?? 0) };
        }),
    );
    expect(limits.map((limit) => limit.id)).toEqual(["browser", "e2e"]);
    for (const limit of limits) expect(longest, limit.id).toBeLessThanOrEqual(limit.seconds);
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
      [
        "bend-proofs",
        "browser",
        "build-test",
        "cire-api-tests",
        "d1",
        "e2e",
        "migration-flow",
      ].toSorted(),
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

  // The Bend proofs' second check, by the BendTT kernel, is a gate only while
  // its step runs on every run, after the plain check, with a kernel that
  // `bend.sh kernel` checked: the published one, fetched, or, when none is
  // published for the pins, one built from source. A Lean on $GITHUB_PATH
  // would let `verdict` build a kernel nobody checked; a path read inside
  // `echo "…$(…)"` turns a failed check into an empty BENDTT and a green step;
  // a fetch failure other than "not published" must fail, not build.
  test("the Bend proofs job rechecks every set with the checked kernel, after the plain check, on every run", () => {
    const steps = stepsOf(ci.jobs["bend-proofs"]);
    const at = (found: (step: Step) => boolean) => steps.findIndex(found);
    const runs = (command: string) => (step: Step) => (step.run ?? "").includes(command);
    const check = at(runs("bash tools/bend/bend.sh check"));
    const fetch = at((step) => step.id === "kernel-fetch");
    const lean = at(runs("bash tools/bend/install-lean.sh"));
    const kernel = at(runs("bash tools/bend/bend.sh kernel"));
    const verdict = at(runs("bash tools/bend/bend.sh verdict"));
    expect([check, fetch, lean, kernel, verdict].every((i) => i >= 0)).toBe(true);
    expect([check < fetch, fetch < lean, lean < kernel, kernel < verdict]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(steps[fetch]?.if).toBe("needs.changes.outputs.bend-pins != 'true'");
    expect(ci.jobs.changes?.outputs?.["bend-pins"]).toBe("${{ steps.classify.outputs.bend-pins }}");
    expect(steps[fetch]?.run).toContain(
      'bash tools/bend/bend.sh fetch "$RUNNER_TEMP/bendtt" || status=$?',
    );
    expect(steps[fetch]?.run).toContain('0) echo "published=true" >> "$GITHUB_OUTPUT" ;;');
    expect(steps[fetch]?.run).toContain('3) echo "published=false" >> "$GITHUB_OUTPUT" ;;');
    expect(steps[fetch]?.run).toContain('*) exit "$status" ;;');
    expect(steps[lean]?.if).toBe("steps.kernel-fetch.outputs.published != 'true'");
    expect(steps[kernel]?.if).toBeUndefined();
    expect(steps[kernel]?.run).toMatch(
      /^kernel=\$\(bash tools\/bend\/bend\.sh kernel "\$RUNNER_TEMP\/bendtt"\)$/m,
    );
    expect(steps[kernel]?.run).toContain('echo "BENDTT=$kernel" >> "$GITHUB_ENV"');
    expect(steps[verdict]?.if).toBeUndefined();
    expect(steps[verdict]?.run?.trim()).toBe("bash tools/bend/bend.sh verdict");
    expect(steps[verdict]?.env?.BENDTT).toBe("${{ env.BENDTT }}");
    // The kernel comes from its release or its build, never from the cache.
    expect(steps.filter((step) => String(step.with?.path ?? "").includes("bendtt"))).toEqual([]);
    for (const step of steps) {
      expect({
        name: step.name,
        path: /GITHUB_PATH/.test(step.run ?? "") && /lean/i.test(step.run ?? ""),
      }).toEqual({
        name: step.name,
        path: false,
      });
    }
  });
});

// The release holding CI's BendTT kernel is the one thing in this repository
// a workflow publishes to the public. Only the job that publishes holds a
// write token, only on main and only when asked; the job that runs Bend and
// Lean reads; nothing that job writes reaches the publishing job's checkout;
// and an asset once published is never overwritten.
describe("bendtt-release.yml publishes the BendTT kernel only from main, by hand, and replaces nothing", () => {
  const release = load(".github/workflows/bendtt-release.yml");
  const text = readFileSync(join(root, ".github/workflows/bendtt-release.yml"), "utf8");

  test("it runs only when dispatched, publishes only when asked, and the workflow token holds nothing", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(release.permissions).toEqual({});
    const inputs = (release.on.workflow_dispatch as { inputs?: Record<string, unknown> }).inputs;
    expect(inputs?.publish).toMatchObject({ type: "boolean", default: false });
  });

  test("the build job reads; the publish job alone writes, from main, when asked, after the build", () => {
    expect(Object.keys(release.jobs).toSorted()).toEqual(["build", "publish"]);
    expect(release.jobs.build?.permissions).toEqual({ contents: "read" });
    expect(release.jobs.publish?.permissions).toEqual({ contents: "write" });
    expect(release.jobs.publish?.if).toBe("inputs.publish && github.ref == 'refs/heads/main'");
    expect(needsOf(release.jobs.publish!)).toEqual(["build"]);
  });

  test("the publish job runs no Bend or Lean, takes the kernel outside its checkout, and never overwrites an asset", () => {
    const steps = stepsOf(release.jobs.publish);
    const runs = steps.map((step) => step.run ?? "").join("\n");
    expect(runs).not.toMatch(
      /install-bend|install-lean|bend\.sh (kernel|verdict|check|prove|build|hook)/,
    );
    const download = steps.find((step) => step.uses === "actions/download-artifact@v4");
    expect(download?.with).toEqual({ name: "bendtt", path: "${{ runner.temp }}/bendtt-artifact" });
    expect(runs).toContain('if [ "$(ls -A "$artifact")" != "bendtt" ]; then');
    expect(runs).toContain("sha256sum -c -");
    // `git ls-remote --exit-code` exits 2 for no such tag and 128 when it
    // cannot ask: only 2 may lead to creating the release.
    expect(runs).toContain(
      'git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || tagged=$?',
    );
    expect(runs).toMatch(/^\s*2\) gh release create /m);
    expect(text).not.toContain("--clobber");
    expect(text).not.toMatch(/gh release (delete|edit)/);
    const upload = stepsOf(release.jobs.build).find(
      (step) => step.uses === "actions/upload-artifact@v4",
    );
    expect(upload?.with?.path).toBe("${{ runner.temp }}/bendtt/bendtt");
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
  // wait. E2E runs on a pull request alone: the merge queue and the push to
  // main skip it, so no change runs the suite twice.
  test("each build, test and E2E job runs unless the detection says prose only, E2E on a pull request only; lint, scripts and the secret scan always run", () => {
    const waiting = Object.entries(ci.jobs)
      .filter(([, job]) => needsOf(job).includes("changes"))
      .map(([id]) => id);
    expect(waiting.toSorted()).toEqual([...SKIPPABLE, "bend-proofs", "ci"].toSorted());
    // The Bend proofs read only their own files: the classifier's `bend`
    // output, true for any change to them and whenever no diff was computed.
    expect(ci.jobs["bend-proofs"]?.if).toBe("needs.changes.outputs.bend == 'true'");
    for (const id of SKIPPABLE) {
      expect({ id, if: ci.jobs[id]?.if }).toEqual({
        id,
        if: id === "e2e" ? `github.event_name == 'pull_request' && ${SKIP}` : SKIP,
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
  ): {
    readonly exitCode: number;
    readonly output: string;
    readonly verdict: string;
    readonly bend: string;
    readonly bendPins: string;
  } {
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
      bend: /^bend=(.*)$/m.exec(written)?.[1] ?? "<none>",
      bendPins: /^bend-pins=(.*)$/m.exec(written)?.[1] ?? "<none>",
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
    const { exitCode, output, verdict, bend, bendPins } = classify([["wiki/a.md"]], pullRequest, {
      classifierOnBase: false,
    });
    expect({ exitCode, verdict, bend, bendPins }, output).toEqual({
      exitCode: 0,
      verdict: "false",
      bend: "true",
      bendPins: "true",
    });
  });

  // The Bend proofs read the law sets (`<workspace>/laws/<topic>/`), the
  // toolchain in tools/bend/ and this workflow, and nothing else; a change to
  // none of them skips the job.
  test.each([
    ["a change to osn-api's laws", "true", [["osn/api/laws/account-deletion/account.bend"]]],
    ["a change to cire-api's model", "true", [["cire/api/laws/account-deletion/model.mjs"]]],
    ["a change to a new set elsewhere", "true", [["zap/api/laws/messaging/LAWS.bend"]]],
    ["a change to the toolchain", "true", [["tools/bend/install-bend.sh"]]],
    ["a change to the agreement tests", "false", [["osn/api/tests/laws/model.ts"]]],
    ["a change to this workflow", "true", [[".github/workflows/ci.yml"]]],
    ["a change to a service the model describes", "false", [["osn/api/src/a.ts"]]],
    ["a change of prose", "false", [["wiki/a.md"]]],
  ] as const)("%s: the Bend proofs run is %s", (_, expected, commits) => {
    const { exitCode, output, bend } = classify(commits, pullRequest);
    expect({ exitCode, bend }, output).toEqual({ exitCode: 0, bend: expected });
  });

  // A change to a pin names a kernel only a build from source has shown, so
  // the Bend proofs build it rather than fetch whatever a writer may have
  // published under that name first: on the pull request, its queue group and
  // its push to main.
  test.each([
    ["a change to the Bend pin", "true", [["tools/bend/bend.env"]], pullRequest],
    ["a change to the Lean and kernel pins", "true", [["tools/bend/lean.env"]], pullRequest],
    [
      "a queue group with a pin change ahead of it",
      "true",
      [["tools/bend/lean.env"], ["wiki/a.md"]],
      queue,
    ],
    [
      "a push that changes a pin",
      "true",
      [["tools/bend/lean.env"]],
      (shas: readonly string[]) => ({ EVENT: "push", BEFORE: shas[0] ?? "" }),
    ],
    ["a change to bend.sh alone", "false", [["tools/bend/bend.sh"]], pullRequest],
    [
      "a change to a law set alone",
      "false",
      [["osn/api/laws/account-deletion/account.bend"]],
      pullRequest,
    ],
  ] as const)("%s: the kernel is built from source is %s", (_, expected, commits, event) => {
    const { exitCode, output, bendPins } = classify(commits, event);
    expect({ exitCode, bendPins }, output).toEqual({ exitCode: 0, bendPins: expected });
  });
});

describe("CI's E2E job runs the suite once and retries the whole run only when it fails; the determinism check runs daily and by hand", () => {
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
    expect(steps.filter((step) => step.run?.includes("test:e2e"))).toHaveLength(1);
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

  // The determinism check runs the whole suite twice. On a pull request that
  // is two runs more than the one CI's E2E job makes, so it runs on its daily
  // schedule and by hand only; without the schedule nothing compares two runs,
  // and nothing runs the suite on main.
  test("the determinism job runs test:e2e:repro daily and by hand only: never on a pull request, a push or a merge-queue group", () => {
    expect(Object.keys(repro.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
    expect(repro.on.schedule).toEqual([{ cron: "17 5 * * *" }]);
    expect(repro.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(repro.jobs);
    expect(jobs.map((job) => job.name)).toEqual(["E2E determinism"]);
    // Nothing to cancel: no event here supersedes an earlier run.
    expect(jobs[0]?.concurrency).toBeUndefined();
    expect(
      (jobs[0]?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run])),
    ).toEqual(["bun run test:e2e:repro"]);
  });

  // Of the workflows a pull request, a push or a merge-queue group starts, one
  // step of one job runs the suite: CI's E2E, which runs on a pull request
  // alone. A second run happens only when e2e-with-retry.sh retries a failed
  // one.
  test("of the workflows a pull request, a push or a merge-queue group starts, only CI's E2E step runs the suite, and nothing runs test:e2e:repro", () => {
    const CHANGE_EVENTS = new Set(["pull_request", "pull_request_target", "push", "merge_group"]);
    const workflows = Array.from(
      new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
    ).toSorted();
    expect(workflows).toContain(".github/workflows/e2e-repro.yml");
    const suiteSteps = workflows.flatMap((path) => {
      const workflow = load(path);
      if (!Object.keys(workflow.on).some((event) => CHANGE_EVENTS.has(event))) return [];
      return Object.entries(workflow.jobs).flatMap(([id, job]) =>
        stepsOf(job)
          .filter((step) =>
            /\btest:e2e\b|\be2e:repro\b|tools\/e2e\b|\bplaywright test\b/.test(step.run ?? ""),
          )
          .map((step) => `${path} ${id}: ${step.run}`),
      );
    });
    expect(suiteSteps).toEqual([
      ".github/workflows/ci.yml e2e: bash scripts/e2e-with-retry.sh 2 720 bun run test:e2e",
    ]);
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

// The gift against Stripe's test mode reads a real test key. Only main may
// deploy from its Environment, which the preflight checks; a pull request,
// a push or a queue group never runs it; and the key reaches two steps, the
// preflight that checks its shape and the run, never an install or an action.
describe("the Stripe test-mode job runs nightly and by hand, and holds its key in two steps", () => {
  const workflow = load(".github/workflows/e2e-stripe-test-mode.yml");
  const jobs = Object.values(workflow.jobs);
  const steps = jobs[0]?.steps ?? [];
  const KEY = "secrets.STRIPE_TEST_SECRET_KEY";
  const PREFLIGHT_SAID_RUN = "steps.preflight.outputs.run == 'true'";

  test("on its schedule and by hand only, reading the checkout and the Environment's branches", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.environment).toBe("stripe-test-mode");
  });

  test("the key is read by the preflight and the run alone, and no secret by anything else", () => {
    const reading = steps.filter((step) => JSON.stringify(step).includes("secrets."));
    expect(reading.map((step) => step.id ?? step.run)).toEqual([
      "preflight",
      "bun run test:e2e:stripe",
    ]);
    for (const step of reading) {
      expect(step.uses).toBeUndefined();
      expect(step.run ?? "").not.toMatch(/\bbun install\b|\bbun add\b/);
      expect(JSON.stringify(step.env)).toContain(KEY);
    }
    expect(JSON.stringify({ ...jobs[0], steps: [] })).not.toContain("secrets.");
    // A workflow-level value reaches every step, the checkout and the install included.
    expect(JSON.stringify(workflow.env ?? {})).not.toContain("secrets.");
  });

  test("every step after the preflight waits on its answer, and the upload runs on failure too", () => {
    const at = steps.findIndex((step) => step.id === "preflight");
    expect(at).toBeGreaterThan(0);
    const after = steps.slice(at + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after) {
      if (step.uses === "actions/upload-artifact@v4") {
        expect(step.if).toBe(`always() && ${PREFLIGHT_SAID_RUN}`);
      } else {
        expect(step.if, step.name ?? step.uses).toBe(PREFLIGHT_SAID_RUN);
      }
    }
    expect(after.filter((step) => step.uses === "actions/upload-artifact@v4")).toHaveLength(1);
  });

  // The run step executes the installed packages and Chromium holding the key,
  // and any workflow on main can write the caches the setup would restore.
  test("installs without the shared bun and Chromium caches, and bounds the Stripe CLI download", () => {
    const setups = steps.filter((step) => step.uses === "./.github/actions/e2e-setup");
    expect(setups.map((step) => step.with?.cache)).toEqual(["false"]);
    const action = Bun.YAML.parse(
      readFileSync(join(root, ".github/actions/e2e-setup/action.yml"), "utf8"),
    ) as CompositeAction;
    const onCaches = (action.runs.steps ?? []).filter(
      (step) =>
        ["~/.bun/install/cache", "~/.cache/ms-playwright", "~/.cache/chromium-apt"].includes(
          String(step.with?.path),
        ) || step.id === "chromium-apt-key",
    );
    // The bun and browser caches; the system packages' key, restore and save.
    expect(onCaches.map((step) => step.with?.path ?? step.id)).toEqual([
      "~/.bun/install/cache",
      "~/.cache/ms-playwright",
      "chromium-apt-key",
      "~/.cache/chromium-apt",
      "~/.cache/chromium-apt",
    ]);
    for (const step of onCaches) {
      expect(step.if?.split(" && "), step.name).toContain("inputs.cache != 'false'");
      expect(step.if, step.name).not.toContain("||");
    }
    const cli = steps.find((step) => step.name === "Install the Stripe CLI");
    expect(cli?.["timeout-minutes"]).toBeLessThanOrEqual(5);
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

  // Per stack: a plan at approval 1, and a re-plan, the migrate step and a
  // deploy in its stack job. One test per run: each spawns a shell twice, and
  // a loop over all of them in one test spends its whole budget on a loaded
  // runner.
  const alchemyRuns = Object.entries(production.jobs).flatMap(([id, job]) =>
    stepsOf(job).flatMap((step, at) =>
      /\b(plan|migrate|deploy):production\b/.test(step.run ?? "") ? [{ id, job, step, at }] : [],
    ),
  );

  test("PW10: every stack has its four Alchemy runs", () => {
    expect(alchemyRuns).toHaveLength(4 * PRODUCTION_STACKS.length);
  });

  test.each(alchemyRuns.map((run) => [`${run.id}: ${run.step.name}`, run] as const))(
    "PW10: no production Alchemy run writes to the public run log, each writes a file, which the next step shows only when the run failed (%s)",
    (_name, { job, step, at }) => {
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
      // A plan reads no ledger; a migrate or deploy run can name a production
      // ledger's migrations, so its log is shown with every file name masked
      // (PW1 runs the masking).
      expect(show?.run).toBe(
        /plan:production/.test(step.run ?? "")
          ? `cat "${file}"`
          : `# Migration file names are masked, so no name a production ledger\n# holds reaches this public log (AGENTS.md, Production data).\nsed -E 's/[[:alnum:]_.-]+\\.sql/<migration file>/g' "${file}"\n`,
      );
    },
  );

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

  test("its production jobs are alchemy-plan and each stack's job; its record jobs the map's production surfaces", () => {
    const ids = jobsIn(production, "production").map(([id]) => id);
    expect(ids.toSorted()).toEqual(
      ["alchemy-plan", ...PRODUCTION_STACKS.map((s) => s.production.id)].toSorted(),
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

  test("PW12: no step runs `wrangler deploy`: every production Worker deploys through its stack", () => {
    const deploying = Object.entries(production.jobs).flatMap(([id, job]) =>
      stepsOf(job)
        .filter((step) => /\bwrangler\b[^\n]*\bdeploy\b/.test(step.run ?? ""))
        .map((step) => `${id}: ${step.name}`),
    );
    expect(deploying).toEqual([]);
    expect(JSON.stringify(production)).not.toContain("WRANGLER_OUTPUT_FILE_PATH");
  });

  test("RP8: each Environment keeps its own window: a release leaves at most 4 records in production (75 releases) and 9 in production-records (33)", () => {
    // Counted with one attempt per job: a re-run, or a rejected approval,
    // leaves a record of its own.
    const inProduction = jobsIn(production, "production").map(([id]) => id);
    // A release runs at most every production job.
    const release = inProduction.length;
    expect(release).toBe(4);
    expect(Math.floor(MAX_RECORDS / release)).toBeGreaterThanOrEqual(75);
    // One record job per surface a production stack deploys. A surface whose
    // stack has not shipped for longer than the window ships again, which
    // costs one no-op deploy.
    const records = jobsIn(production, "production-records").length;
    expect(records).toBe(PRODUCTION_SURFACES.filter(stackDeployed).length);
    expect(records).toBeLessThanOrEqual(9);
    expect(Math.floor(MAX_RECORDS / 9)).toBeGreaterThanOrEqual(33);
  });
});

const GATE_NEEDS = ["alchemy-plan", "build", "plan", "sites"];

/** A production stack's job in production-release.yml. */
const productionStackJob = (key: StackKey): Job => {
  const id = PRODUCTION_STACKS.find((s) => s.key === key)?.production.id ?? "";
  const job = production.jobs[id];
  if (job === undefined) throw new Error(`production-release.yml has no ${id} job`);
  return job;
};
/** The surfaces a production stack deploys, API Workers and sites, in map order. */
const productionSitesOf = (key: StackKey): readonly SurfaceKey[] =>
  PRODUCTION_SURFACES.filter((s) => s.stack === key && stackDeployed(s)).map((s) => s.key);
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
const PRODUCTION_BUILDS: Readonly<Partial<Record<SurfaceKey, Record<string, string>>>> = {
  cire_invites: {
    PUBLIC_API_URL: "https://api.cireweddings.com",
    PUBLIC_SITE_URL: "https://invite.cireweddings.com",
    PUBLIC_MARKETING_URL: "https://cireweddings.com",
    PUBLIC_TURNSTILE_SITEKEY: "${{ vars.PUBLIC_TURNSTILE_SITEKEY }}",
    PUBLIC_GOOGLE_MAPS_EMBED_KEY: "${{ vars.PUBLIC_GOOGLE_MAPS_EMBED_KEY }}",
    PUBLIC_BUILD_SHA: "${{ github.sha }}",
    OSN_DEPLOY_TIER: "production",
  },
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

describe("PW4: the sites job builds each production site, and the guest site's Worker, once", () => {
  // The guest site first, then the sites in map order: the order the job builds them.
  const builds: readonly (readonly [SurfaceKey, string, string])[] = [
    ...Object.entries(PREBUILT_WORKER_BUILDS).map(
      ([key, build]) => [key as SurfaceKey, build.package, build.directory] as const,
    ),
    ...PRODUCTION_SURFACES.filter(
      (s) => stackDeployed(s) && SITE_SURFACES.includes(s.key as SiteSurface),
    ).map(
      (s) =>
        [
          s.key,
          SITE_BUILDS[s.key as SiteSurface].package,
          SITE_BUILDS[s.key as SiteSurface].directory,
        ] as const,
    ),
  ];

  test("needs the plan alone, so it runs beside build, runs when a site build is needed, restores no turbo cache, and holds no Environment or secret", () => {
    expect(needsOf(sitesJob)).toEqual(["plan"]);
    expect(stepsOf(sitesJob).filter((step) => step.with?.path === ".turbo")).toEqual([]);
    expect(sitesJob.if).toBe("needs.plan.outputs.any_stack == 'true'");
    expect(environmentOf(sitesJob)).toBeUndefined();
    expect(JSON.stringify(sitesJob)).not.toContain("secrets.");
  });

  test.each(builds.map(([key, pkg]) => [key, pkg] as const))(
    "%s: one build with its production values, when its stack ships",
    (key, pkg) => {
      const found = buildsOf(sitesJob).filter((step) => BUILD.exec(step.run ?? "")?.[1] === pkg);
      expect(found).toHaveLength(1);
      expect(found[0]?.env).toEqual(PRODUCTION_BUILDS[key]);
      expect(found[0]?.if).toBe(`needs.plan.outputs.stack_${surface(key).stack} == 'true'`);
    },
  );

  test("builds nothing else, and keeps every build with its hidden files", () => {
    expect(buildsOf(sitesJob)).toHaveLength(builds.length);
    const steps = stepsOf(sitesJob);
    const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
    expect(upload?.with).toEqual({
      name: "production-sites",
      path: ["production-sites.txt", ...builds.map(([, , directory]) => directory), ""].join("\n"),
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 7,
    });
    expect(steps.indexOf(upload!)).toBe(steps.length - 1);
    // The builds a token-holding job lets in are the ones uploaded.
    expect(SITE_DIRECTORIES).toEqual(builds.map(([, , directory]) => directory));
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
        FORCE: `\${{ (inputs.force == true || steps.snapshot_${s.key}.outputs.force == 'true') && 'yes' || '' }}`,
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
      const guardedArgs = `^run plan:guard -- --log \\S+/plan/${s.key}\\.log --out \\S+/alchemy-plan/${s.key}\\.json --domains \\S+/domains-${s.key}\\.json --live \\S+/live-${s.key}\\.json`;
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
      // What the stack's adopted resources hold live, read with the production pair.
      const live = stepById(planJob, `live_${s.key}`);
      expect(live?.if).toBe(when);
      expect(live?.["working-directory"]).toBe(`${s.key}/infra`);
      expect(live?.run).toBe(`bun run read:live -- --out "$RUNNER_TEMP/live-${s.key}.json"`);
      expect(live?.env).toEqual(PRODUCTION_CREDENTIALS);
      const order = [
        at("token"),
        at("state"),
        at(`snapshot_${s.key}`),
        at(`worker_domains_${s.key}`),
        at(`live_${s.key}`),
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
    // It runs each stack's guard step in a shell, three times over.
  }, 30_000);
});

describe("PW1: one production job per stack with a production deploy", () => {
  test("the stack jobs are the map's production stacks", () => {
    const ids = Object.keys(production.jobs).filter((id) => /^stack-[a-z]+-production$/.test(id));
    expect(ids.toSorted()).toEqual(PRODUCTION_STACKS.map((s) => s.production.id).toSorted());
    expect(PRODUCTION_STACKS.map((s) => s.key).toSorted()).toEqual(["cire", "musubi", "zap"]);
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
      const guarded = `^run plan:guard -- --log \\S+/plan/${key}\\.log --out \\S+/plan-guard/${key}\\.json --domains \\S+/domains\\.json --live \\S+/live\\.json --approved \\S+/approved/${key}\\.json`;
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
      // A refusal fails the guard step; only the migration, and its log on a
      // failure, stand between it and the deploy.
      expect(runStep(guard!, {}, 1).exitCode).not.toBe(0);
      expect(stepIndex(job, "migrate")).toBe(stepIndex(job, "guard") + 1);
      expect(stepIndex(job, "deploy")).toBe(stepIndex(job, "migrate") + 2);
      // Alchemy migrates the stack's production database, on every release
      // the stack ships, by deploying that database alone
      // (`<stack>/infra`'s `migrate:production`, `--force --include <id>`):
      // a migration that fails stops the job before anything else uploads.
      const migrate = stepById(job, "migrate");
      expect({
        if: migrate?.if,
        continues: migrate?.["continue-on-error"],
        cwd: migrate?.["working-directory"],
        env: migrate?.env,
      }).toEqual({
        if: undefined,
        continues: undefined,
        cwd: `${key}/infra`,
        env: { DO_NOT_TRACK: "1", OSN_DEPLOY_TIER: "production", ...PRODUCTION_CREDENTIALS },
      });
      expect(runStep(migrate!, {}).bunCalls).toEqual(["run migrate:production"]);
      expect(runStep(migrate!, {}, 3).exitCode).not.toBe(0);
      const log = stepsOf(job)[stepIndex(job, "migrate") + 1];
      expect(log?.if).toBe("${{ failure() && steps.migrate.outcome == 'failure' }}");
      expect(log?.env).toBeUndefined();
      // On a failure it prints Alchemy's log with every migration file name
      // masked, as the deploy's log step does: a production ledger's names
      // stay out of the public run log.
      const deployLog = stepsOf(job)[stepIndex(job, "deploy") + 1];
      expect(deployLog?.if).toBe("${{ failure() && steps.deploy.outcome == 'failure' }}");
      for (const [step, file] of [
        [log, "migrate.log"],
        [deployLog, "alchemy.log"],
      ] as const) {
        const dir = mkdtempSync(join(tmpdir(), "migrate-log-"));
        writeFileSync(
          join(dir, file),
          "MigrationHistoryConflictError: 1 recorded migration(s) match no local file: 0050_stray_name.sql, 20990101000000_x.sql. D1 said no\n",
        );
        const shown = Bun.spawnSync(["bash", "-e", "-c", step?.run ?? "exit 9"], {
          env: { PATH: "/usr/bin:/bin", RUNNER_TEMP: dir },
        });
        expect(shown.exitCode).toBe(0);
        expect(shown.stdout.toString()).toBe(
          "MigrationHistoryConflictError: 1 recorded migration(s) match no local file: <migration file>, <migration file>. D1 said no\n",
        );
      }
      // Wrangler's migrator reaches no production database from any workflow.
      expect(JSON.stringify(job)).not.toMatch(/db:migrate:prod|d1 migrations apply/);
      const live = stepById(job, "live");
      expect(live?.run).toBe('bun run read:live -- --out "$RUNNER_TEMP/live.json"');
      expect(live?.["working-directory"]).toBe(`${key}/infra`);
      expect(live?.env).toEqual(PRODUCTION_CREDENTIALS);
      expect(deploy?.["working-directory"]).toBe(`${key}/infra`);
      expect(deploy?.env).toEqual({
        FORCE:
          "${{ (inputs.force == true || steps.snapshot.outputs.force == 'true') && 'yes' || '' }}",
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
        "live",
        "plan",
        "guard",
        "migrate",
        "deploy",
        "deployments",
        "kept",
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
        // The guest site's check also asks for the marketing origin its `/`
        // redirects to; osn-api's sends the coordination probe its bearer.
        expect(smoke?.env).toEqual({
          SMOKE_ORIGIN: `\${{ steps.hosts.outputs.${site}_origin }}`,
          SMOKE_DEPLOYMENT: `\${{ steps.deployments.outputs.${site}_deployment }}`,
          ...(productionTarget(site)?.needsMarketing === true
            ? { SMOKE_MARKETING_ORIGIN: "${{ steps.hosts.outputs.cire_landing_origin }}" }
            : {}),
          ...(site === "osn_api"
            ? { INTERNAL_SERVICE_SECRET: "${{ secrets.INTERNAL_SERVICE_SECRET }}" }
            : {}),
          ...PRODUCTION_CREDENTIALS,
        });
        expect(productionTarget(site)).toBeDefined();
      }
      // Every secret live before the deploy must be live after it.
      const kept = stepById(job, "kept");
      expect(kept?.run).toBe(
        'bun run read:live -- --out "$RUNNER_TEMP/live-after.json" --kept "$RUNNER_TEMP/live.json"',
      );
      expect(kept?.if).toBe(ON_DEPLOY);
      expect(kept?.["continue-on-error"]).toBe(true);
      expect(kept?.env).toEqual(PRODUCTION_CREDENTIALS);
      const failed = [
        "steps.deployments.outcome == 'failure'",
        "steps.kept.outcome == 'failure'",
        ...sites.map((site) => `steps.smoke_${site}.outcome == 'failure'`),
      ];
      const last = stepsOf(job).at(-1);
      expect(last?.if).toBe(`\${{ !cancelled() && (${failed.join(" || ")}) }}`);
      expect(last?.run).toContain("exit 1");
      expect(job.outputs).toEqual({
        deployed:
          "${{ steps.deploy.outcome == 'success' && steps.deployments.outcome == 'success' && steps.kept.outcome == 'success' }}",
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

  test("every job that fetches the builds: alchemy-plan and each stack job that deploys one", () => {
    // The zap stack deploys no build: it bundles zap-api from source.
    expect(downloads.map(({ id }) => id).toSorted()).toEqual(
      [
        "alchemy-plan",
        ...PRODUCTION_STACKS.filter((s) => s.key !== "zap").map((s) => s.production.id),
      ].toSorted(),
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

const recordSurfaces = PRODUCTION_SURFACES;
const surface = (key: SurfaceKey): Surface => SURFACES.find((s) => s.key === key)!;

/** The environment variables a check's probes send as bearers, once each. */
const bearersOf = (probes: readonly Probe[]): string[] => [
  ...new Set(probes.flatMap((probe) => (probe.bearer === undefined ? [] : [probe.bearer]))),
];

describe("every Worker deploy is smoke-checked, and rolls back the Worker it deployed", () => {
  /** Every surface with a dev target, in SMOKE_TARGETS order. */
  const devSmokeKeys = (Object.keys(SMOKE_TARGETS) as SurfaceKey[]).filter(
    (key) => devTarget(key) !== undefined,
  );
  const checkedIn = (job: Job, tier: "dev" | "production") =>
    stepsOf(job).flatMap((step) => {
      const match = /^bun run scripts\/smoke-check\.ts (\S+) (\S+)$/.exec(step.run ?? "");
      return match === null || match[2] !== tier ? [] : [match[1]!];
    });

  test("production: each stack job checks every surface it deploys once, and no other job checks any", () => {
    for (const s of PRODUCTION_STACKS) {
      expect(checkedIn(productionStackJob(s.key), "production")).toEqual([
        ...productionSitesOf(s.key),
      ]);
    }
    const elsewhere = Object.entries(production.jobs)
      .filter(([id]) => !PRODUCTION_STACKS.some((s) => s.production.id === id))
      .flatMap(([, job]) => checkedIn(job, "production"));
    expect(elsewhere).toEqual([]);
    // Every surface with a production target is deployed, so checked, by its stack.
    const targets = PRODUCTION_SURFACES.filter((s) => productionTarget(s.key) !== undefined);
    expect(
      PRODUCTION_STACKS.flatMap((s) =>
        checkedIn(productionStackJob(s.key), "production"),
      ).toSorted(),
    ).toEqual(targets.map((s) => s.key).toSorted());
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

/**
 * The narrower installs only production-release.yml runs: an Alchemy job's
 * own stack trees, with the API workspaces each stack bundles and migrates.
 */
const PRODUCTION_ONLY_INSTALLS = [
  "bun install --frozen-lockfile --filter @cire/infra --filter @cire/api --filter @musubi/infra --filter @osn/api --filter @osn/db --filter @zap/infra --filter @zap/api",
  "bun install --frozen-lockfile --filter @cire/infra --filter @cire/api",
  "bun install --frozen-lockfile --filter @musubi/infra --filter @osn/api --filter @osn/db",
  "bun install --frozen-lockfile --filter @zap/infra --filter @zap/api",
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

// ci-swift.yml's filter reads `git diff --name-only`, which wraps a name
// holding a quote, a backslash, a control character or a non-ASCII byte in
// double quotes. Such a name still starts its path inside the quotes, so a
// Swift file with one still runs the Swift jobs.
describe("ci-swift.yml's change filter", () => {
  const filter = load(".github/workflows/ci-swift.yml").jobs.changes?.steps?.find(
    (s) => s.id === "filter",
  );

  // git's defaults, whatever the machine sets: `core.quotepath` is what
  // quotes a non-ASCII name.
  const GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

  /** The filter step's `ios` output, and its log, for a push that adds `files`. */
  function filterRun(files: readonly string[]): { ios: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "ci-swift-changes-"));
    try {
      const git = (...args: string[]) => {
        const proc = Bun.spawnSync(
          ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
          { cwd: dir, env: { PATH: process.env.PATH ?? "", ...GIT } },
        );
        if (proc.exitCode !== 0)
          throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
        return proc.stdout.toString().trim();
      };
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "base.txt"), "base\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), "changed\n");
      }
      git("add", ".");
      git("commit", "-qm", "change");
      const outputFile = join(dir, "github-output");
      const step = Bun.spawnSync(
        ["bash", "--noprofile", "--norc", "-e", "-c", filter?.run ?? "exit 9"],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "",
            ...GIT,
            GITHUB_OUTPUT: outputFile,
            EVENT_NAME: "push",
            BEFORE_SHA: base,
          },
        },
      );
      const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
      return { ios: /^ios=(.*)$/m.exec(written)?.[1] ?? "<none>", log: step.stdout.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.each([
    ["pulse/ios/Views/Explore.swift", "true"],
    ["pulse/ios/Views/Café.swift", "true"],
    ['shared/swift/Sources/Say "hi".swift', "true"],
    ["README.md", "false"],
    ['wiki/Say "hi".md', "false"],
  ])("%s runs the Swift jobs: %s", (file, expected) => {
    expect(filterRun([file]).ios).toBe(expected);
  });

  test("a file's name cannot write a workflow command into the step's log", () => {
    const { ios, log } = filterRun(["::warning::forged", "pulse/ios/a.swift"]);
    expect(ios).toBe("true");
    expect(log).toContain("  - ::warning::forged\n");
    expect(log.split("\n").filter((line) => line.trimStart().startsWith("::"))).toEqual([]);
  });
});
