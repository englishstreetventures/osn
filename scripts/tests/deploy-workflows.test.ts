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
  PRODUCTION_SURFACES,
  stack,
  type StackKey,
  STACKS,
  type Surface,
  type SurfaceKey,
  SURFACES,
  WORKFLOW_FILE,
} from "../deploy-surfaces";
import { devTarget, productionTarget, SMOKE_TARGETS } from "../smoke-check";

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
 * keys are dev Environment variables; ASTRO_KEY fixes the guest site's server
 * build so two builds of one commit are byte-identical. Pulse landing gets no
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
        ASTRO_KEY: "${{ secrets.ASTRO_KEY }}",
      },
    },
    {
      pkg: "@cire/host",
      env: {
        PUBLIC_CIRE_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_OSN_ACCOUNT_URL: hostOutput("musubi_social_origin"),
        PUBLIC_CIRE_WEB_URL: hostOutput("cire_invites_origin"),
      },
    },
    {
      pkg: "@cire/vendor",
      env: {
        PUBLIC_CIRE_API_URL: hostOutput("cire_api_origin"),
        PUBLIC_OSN_ACCOUNT_URL: hostOutput("musubi_social_origin"),
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
  musubi: [],
  cire: ["cire/invites", "cire/host", "cire/vendor", "cire/landing"],
  zap: [],
  pulse: [],
};

const BUILD = /\bbun run build --filter=(\S+)/;
const buildsOf = (job: Job) => stepsOf(job).filter((step) => BUILD.test(step.run ?? ""));

interface ShellRun {
  readonly exitCode: number;
  readonly output: string;
  /** One line per `bun` invocation: its arguments. */
  readonly bunCalls: readonly string[];
}

/**
 * Runs a step's `run` script as GitHub runs one with no `shell:` (`bash -e`),
 * with a stand-in `bun` on PATH that records its arguments and exits with
 * `bunExit`.
 */
function runStep(step: Step, env: Readonly<Record<string, string>>, bunExit = 0): ShellRun {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-step-"));
  const log = join(dir, "bun-calls");
  const bun = join(dir, "bun");
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit ${bunExit}\n`);
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

  test("W5: nothing in it runs or names wrangler", () => {
    expect(readFileSync(join(root, WORKFLOW_FILE.dev), "utf8")).not.toMatch(/wrangler/i);
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
          "${{ runner.os }}-turbo-build-",
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
      [...PRODUCTION_SURFACES.map((s) => s.key), "any"].toSorted(),
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
    expect(listed?.[1]?.split(" ")).toEqual(PRODUCTION_SURFACES.map((s) => s.key));
  });

  test("build runs only when something ships", () => {
    const build = production.jobs.build!;
    expect(needsOf(build)).toEqual(["plan"]);
    expect(build.if).toBe("needs.plan.outputs.any == 'true'");
  });

  test("its production jobs are the map's, no more and no fewer", () => {
    const ids = jobsIn(production, "production").map(([id]) => id);
    expect(ids.toSorted()).toEqual(PRODUCTION_SURFACES.map((s) => s.production.id).toSorted());
  });

  test.each(PRODUCTION_SURFACES.map((s) => [s.key, s] as const))(
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
    expect(env.SMOKE_FORCE_FAIL).toBeUndefined();
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
      SMOKE_FORCE_FAIL: `\${{ inputs.smoke_fail == '${s.key}' }}`,
      ...DEV_CREDENTIALS,
    };
    if (target.needsMarketing) expected.SMOKE_MARKETING_ORIGIN = hostOutput("cire_landing_origin");
    if (target.access) {
      expected.CF_ACCESS_CLIENT_ID = "${{ secrets.CF_ACCESS_CLIENT_ID }}";
      expected.CF_ACCESS_CLIENT_SECRET = "${{ secrets.CF_ACCESS_CLIENT_SECRET }}";
    }
    expect(smoke?.env).toEqual(expected);
  });

  test("deploy.yml's dispatch can force one dev Worker's check to fail", () => {
    const dispatch = dev.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default: string; options: string[] }>;
    };
    const input = dispatch.inputs.smoke_fail;
    expect(input?.type).toBe("choice");
    expect(input?.default).toBe("none");
    expect(input?.options).toEqual(["none", ...devSmokeKeys]);
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
      ...STACKS.map((s) => s.job.name),
    ]);
    const others = otherWorkflows();
    expect(others.length).toBeGreaterThan(0);
    for (const path of others) {
      const jobs = Object.values(load(path).jobs ?? {});
      for (const job of jobs) expect(names.has(job.name ?? "")).toBe(false);
    }
  });
});
