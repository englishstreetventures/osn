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
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAGES_PROJECTS,
  SITE_BUILDS,
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
import { MAX_RECORDS } from "../release-plan";
import { devTarget, productionSiteTarget, productionTarget, SMOKE_TARGETS } from "../smoke-check";

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
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string | boolean>;
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
 * keys are dev Environment variables; the guest site's footer prints the
 * commit (PUBLIC_BUILD_SHA); ASTRO_KEY fixes the guest site's server build so
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
        OSN_DEPLOY_TIER: "dev",
      },
    },
    {
      pkg: "@cire/vendor",
      env: {
        PUBLIC_CIRE_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_OSN_ACCOUNT_URL: hostOutput("musubi_social_origin"),
        OSN_DEPLOY_TIER: "dev",
      },
    },
    {
      pkg: "@cire/landing",
      env: {
        PUBLIC_ORGANISER_URL: hostOutput("cire_host_origin"),
        SITE: hostOutput("cire_landing_origin"),
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

  test("it can only read the repository, and every Alchemy run in it sends no telemetry", () => {
    expect(dev.permissions).toEqual({ contents: "read" });
    // A job-level block would replace the workflow's for that job.
    expect(Object.values(dev.jobs).filter((job) => job.permissions !== undefined)).toEqual([]);
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
    // scripts/guest-route-parity.ts starts `wrangler dev` with an environment
    // of its own (referenceEnv); the step that runs it holds no credential to
    // hand on in the first place.
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
      // no rollback races the next run's deploy.
      expect(job.concurrency).toEqual({ group: `deploy-dev-${key}`, "cancel-in-progress": false });
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
      expect(snapshot?.if).toBeUndefined();

      const deploy = stepById(job, "deploy");
      expect(deploy?.name).toBe(`Deploy the ${key} stack`);
      expect(deploy?.["working-directory"]).toBe(`${key}/infra`);
      expect(deploy?.if).toBeUndefined();
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

  test("holds the guest site's dev origin and the Access service token, and nothing else", () => {
    expect(parity?.env).toEqual({
      PARITY_ORIGIN: hostOutput("cire_invites_origin"),
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
  test("PW11: runs on a schedule and by hand, with the three inputs the planner reads", () => {
    expect(Object.keys(production.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
    const dispatch = production.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default?: unknown }>;
    };
    expect(Object.keys(dispatch.inputs).toSorted()).toEqual(["flip", "force", "surfaces"]);
    expect(dispatch.inputs.surfaces?.type).toBe("string");
    expect(dispatch.inputs.force?.type).toBe("boolean");
    expect(dispatch.inputs.flip).toMatchObject({ type: "string", default: "" });
  });

  test("PW10: every Alchemy run in it sends no telemetry", () => {
    expect(production.env?.DO_NOT_TRACK).toBe("1");
  });

  test("PW10: no production Alchemy run writes to the public run log: each writes a file, which the next step shows only when the run failed", () => {
    const runs = Object.values(production.jobs).flatMap((job) =>
      stepsOf(job).flatMap((step, at) =>
        /\b(plan|deploy):production\b/.test(step.run ?? "") ? [{ job, step, at }] : [],
      ),
    );
    // A plan per stack at approval 1, and a re-plan and a deploy in each stack job.
    expect(runs).toHaveLength(3 * PRODUCTION_STACKS.length);
    for (const { job, step, at } of runs) {
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
        "any_site",
        "any_stack",
        "stacks",
        "flip",
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

  test("the plan job runs the planner over full history, with the token and both inputs", () => {
    const plan = production.jobs.plan;
    expect(checkoutsOf(plan)[0]?.with?.["fetch-depth"]).toBe(0);
    const step = stepsOf(plan).find((s) => s.id === "plan");
    expect(step?.run).toBe("bun run scripts/release-plan.ts");
    expect(step?.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      SURFACES: "${{ inputs.surfaces }}",
      FORCE: "${{ inputs.force }}",
      FLIP: "${{ inputs.flip }}",
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

  test("its production jobs are the map's own jobs, alchemy-plan and the stack jobs; its record jobs the map's stack sites", () => {
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
    // Nothing else holds an Environment: the plan, build, sites and parity jobs read no secret.
    expect(
      Object.entries(production.jobs)
        .filter(([, job]) => environmentOf(job) === undefined)
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(["build", "plan", "site-parity", "sites"]);
  });

  test("RP8: one release leaves at most 16 Deployment records, so the planner's window holds at least 18 releases", () => {
    const recorded =
      jobsIn(production, "production").length + jobsIn(production, "production-records").length;
    expect(recorded).toBeLessThanOrEqual(16);
    expect(Math.floor(MAX_RECORDS / recorded)).toBeGreaterThanOrEqual(18);
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
const sitesJob = production.jobs.sites!;
const planJob = production.jobs["alchemy-plan"]!;

/**
 * The production build of each site, with exactly the values it bakes in:
 * the same hosts each Pages job built with before, and musubi landing's on
 * www.musubi.social with the app on musubi.social.
 */
const PRODUCTION_BUILDS: Readonly<Partial<Record<SiteSurface, Record<string, string>>>> = {
  cire_host: {
    PUBLIC_CIRE_API_URL: "https://api.cireweddings.com",
    PUBLIC_OSN_ACCOUNT_URL: "https://musubi.social",
    PUBLIC_CIRE_WEB_URL: "https://invite.cireweddings.com",
    PUBLIC_MARKETING_URL: "https://cireweddings.com",
    OSN_DEPLOY_TIER: "production",
  },
  cire_vendor: {
    PUBLIC_CIRE_API_URL: "https://api.cireweddings.com",
    PUBLIC_OSN_ACCOUNT_URL: "https://musubi.social",
    OSN_DEPLOY_TIER: "production",
  },
  cire_landing: {
    PUBLIC_ORGANISER_URL: "https://host.cireweddings.com",
    SITE: "https://cireweddings.com",
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

  test("needs plan and build, runs when a site build is needed, and holds no Environment or secret", () => {
    expect(needsOf(sitesJob).toSorted()).toEqual(["build", "plan"]);
    expect(sitesJob.if).toBe("needs.plan.outputs.any_site == 'true'");
    expect(environmentOf(sitesJob)).toBeUndefined();
    expect(JSON.stringify(sitesJob)).not.toContain("secrets.");
  });

  test.each(sites.map((site) => [site] as const))(
    "%s: one build with its production values, when its stack or its own Pages job ships",
    (site) => {
      const pkg = SITE_BUILDS[site].package;
      const builds = buildsOf(sitesJob).filter((step) => BUILD.exec(step.run ?? "")?.[1] === pkg);
      expect(builds).toHaveLength(1);
      expect(builds[0]?.env).toEqual(PRODUCTION_BUILDS[site]);
      expect(builds[0]?.if).toBe(
        `needs.plan.outputs.stack_${surface(site).stack} == 'true' || needs.plan.outputs.${site} == 'true'`,
      );
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

describe("PW5: a staged site's Pages job deploys the sites job's build", () => {
  const pagesSurfaces = ownJobSurfaces.filter(stackDeployed);

  test.each(pagesSurfaces.map((s) => [s.key, s] as const))(
    "%s: fetches the build, builds nothing, and deploys it to its own Pages project with the pinned Wrangler",
    (key, s) => {
      const job = production.jobs[s.production.id]!;
      const steps = stepsOf(job);
      expect(buildsOf(job)).toEqual([]);
      const fetchAt = steps.findIndex((step) => step.uses === "actions/download-artifact@v4");
      expect(steps[fetchAt]?.with).toEqual({ name: "production-sites", path: "." });
      const install = steps.findIndex((step) => /\bbun install\b/.test(step.run ?? ""));
      expect(steps[install]?.run).toBe("bun install --frozen-lockfile --filter '!@*/infra'");
      const deploys = steps.filter((step) => /\bwrangler pages deploy\b/.test(step.run ?? ""));
      expect(deploys).toHaveLength(1);
      expect(deploys[0]?.run).toStartWith(
        `bunx wrangler pages deploy dist --project-name ${PAGES_PROJECTS[key as SiteSurface]}`,
      );
      expect(deploys[0]?.["working-directory"]).toBe(
        SITE_BUILDS[key as SiteSurface].directory.replace(/\/dist$/, ""),
      );
      expect(steps.indexOf(deploys[0]!)).toBeGreaterThan(Math.max(fetchAt, install));
    },
  );

  test("PW12: no Pages job deploys a site whose Worker serves its host", () => {
    const projects = Object.values(production.jobs)
      .flatMap((job) => stepsOf(job))
      .flatMap((step) => {
        const match = /wrangler pages deploy \S+ --project-name (\S+)/.exec(step.run ?? "");
        return match === null ? [] : [match[1] ?? ""];
      });
    expect(projects.toSorted()).toEqual(
      pagesSurfaces.map((s) => PAGES_PROJECTS[s.key as SiteSurface] ?? "").toSorted(),
    );
    for (const s of recordSurfaces) {
      const project = PAGES_PROJECTS[s.key as SiteSurface];
      expect({ key: s.key, deployed: project !== undefined && projects.includes(project) }).toEqual(
        { key: s.key, deployed: false },
      );
    }
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

  test("checks the worker sites' domains with the narrow token before any install, then refuses a flip (PW8)", () => {
    const domains = stepById(planJob, "domains");
    expect(domains?.run).toBe("bun run scripts/pages-domain.ts precheck");
    expect(domains?.env).toEqual({
      FLIP: "${{ needs.plan.outputs.flip }}",
      STACKS: "${{ needs.plan.outputs.stacks }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      CLOUDFLARE_PAGES_DNS_TOKEN: "${{ secrets.CLOUDFLARE_PAGES_DNS_TOKEN }}",
    });
    const install = steps.findIndex((step) => /\bbun install\b/.test(step.run ?? ""));
    expect(at("domains")).toBeLessThan(install);
    const refuse = steps[at("domains") + 1];
    expect(refuse?.if).toBe("needs.plan.outputs.flip != ''");
    expect(runStep(refuse!, { FLIP: "cire_vendor" }).exitCode).not.toBe(0);
    expect(steps.indexOf(refuse!)).toBeLessThan(install);
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
      expect(guard?.env).toEqual({ FLIP: "${{ needs.plan.outputs.flip }}" });
      const guarded = runStep(guard!, { FLIP: "" }).bunCalls;
      expect(guarded).toHaveLength(1);
      expect(guarded[0]).toMatch(
        new RegExp(
          `^run plan:guard -- --log \\S+/plan/${s.key}\\.log --out \\S+/alchemy-plan/${s.key}\\.json$`,
        ),
      );
      expect(runStep(guard!, { FLIP: "musubi_landing" }).bunCalls[0]).toEndWith(
        " --flip musubi_landing",
      );
      const order = [
        at("token"),
        at("state"),
        at(`snapshot_${s.key}`),
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
    const ids = Object.keys(production.jobs).filter((id) => id.startsWith("stack-"));
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
    "%s: snapshot, re-plan, guard against the approved plan, state check, deploy, compare, a check per site, then the verdict, in that order",
    (key) => {
      const job = productionStackJob(key);
      const sites = productionSitesOf(key);
      const steps = stepsOf(job);
      expect(stepById(job, "hosts")?.run).toBe("bun run --cwd shared/infra production-hosts");
      expect(stepById(job, "snapshot")?.run).toBe(
        `bun run scripts/worker-deployments.ts snapshot "$RUNNER_TEMP/deployments.json" --tier production ${sites.join(" ")}`,
      );
      const guard = stepById(job, "guard");
      expect(guard?.run).toContain(`--approved "$RUNNER_TEMP/approved/${key}.json"`);
      expect(guard?.env).toEqual({ FLIP: "${{ needs.plan.outputs.flip }}" });
      const approved = steps.find((step) => step.with?.name === "alchemy-plan");
      expect(approved?.with).toEqual({ name: "alchemy-plan", path: "${{ runner.temp }}/approved" });
      const deploy = stepById(job, "deploy");
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
      expect(stepById(job, "plan")?.env?.FORCE).toBe(deploy?.env?.FORCE);
      const compare = stepById(job, "deployments");
      expect(compare?.run).toBe(
        `bun run scripts/worker-deployments.ts compare "$RUNNER_TEMP/deployments.json" --tier production ${sites.join(" ")}`,
      );
      expect(compare?.if).toBe(ON_DEPLOY);
      expect(compare?.["continue-on-error"]).toBe(true);
      const order = [
        "hosts",
        "token",
        "snapshot",
        "plan",
        "guard",
        "state",
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

describe("PW7: the staged sites are compared with Pages after the stack jobs", () => {
  const parity = production.jobs["site-parity"]!;

  test("needs the stack jobs, holds no Environment or secret, and keeps its report whatever it found", () => {
    expect(needsOf(parity).toSorted()).toEqual(
      ["plan", "sites", ...PRODUCTION_STACKS.map((s) => s.production.id)].toSorted(),
    );
    expect(parity.if).toBe("${{ !cancelled() && needs.sites.result == 'success' }}");
    expect(environmentOf(parity)).toBeUndefined();
    expect(JSON.stringify(parity)).not.toContain("secrets.");
    for (const s of PRODUCTION_STACKS) {
      const step = stepById(parity, `parity_${s.key}`);
      expect(step?.run).toBe(
        `bun run scripts/site-parity.ts --stack ${s.key} --out "$RUNNER_TEMP/site-parity/${s.key}.json"`,
      );
      expect(step?.if).toBe(`needs.${s.production.id}.outputs.deployed == 'true'`);
      expect(step?.["continue-on-error"]).toBe(true);
    }
    const upload = stepsOf(parity).at(-1);
    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(upload?.if).toBe("${{ !cancelled() }}");
    expect(upload?.with?.name).toBe("site-parity");
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
    expect(smoke?.env).toEqual(expected);
  });
});

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

  test("'!@*/infra' leaves out every workspace that depends on alchemy", () => {
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
      .filter((manifest) => "alchemy" in { ...manifest.dependencies, ...manifest.devDependencies })
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
  // never sees it.
  test("deploys no Worker", () => {
    for (const path of otherWorkflows()) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).not.toMatch(/\bwrangler (versions )?deploy\b|cloudflare\/wrangler-action/);
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
