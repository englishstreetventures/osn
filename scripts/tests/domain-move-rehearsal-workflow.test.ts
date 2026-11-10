// Holds .github/workflows/domain-move-rehearsal.yml to what makes it safe to
// dispatch: it reaches the dev account alone, with the dev deploy token and
// account id and nothing else; each credential reaches only the steps that
// use it, each checked first; the rehearsed Pages and DNS steps run with
// nothing installed (as production's detach and attach jobs do); the
// rollback runs after a failed flip, and the cleanup runs whatever happened
// before it, cancellation included.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTACH_JOB_NAME,
  HOLD_DEFAULT_MINUTES,
  HOLD_MAX_MS,
  JOB_STEPS,
  PAGES_WAIT_MS,
  PIN_TIMEOUT_MS,
  WAIT_WATCH_CAP_MS,
  WATCH_CAP_MS,
  WATCH_JOB_NAME,
  WORKER_WAIT_MS,
} from "../domain-move-rehearsal";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, string | number | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly concurrency?: unknown;
  readonly "timeout-minutes"?: number;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | boolean>>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Readonly<Record<string, Job>>;
}

const root = join(import.meta.dir, "..", "..");
const PATH = ".github/workflows/domain-move-rehearsal.yml";
const text = readFileSync(join(root, PATH), "utf8");
const workflow = Bun.YAML.parse(text) as Workflow;
const jobs = workflow.jobs;
const stepsOf = (id: string) => jobs[id]?.steps ?? [];
const needsOf = (job: Job | undefined) =>
  typeof job?.needs === "string" ? [job.needs] : [...(job?.needs ?? [])];
const secretsIn = (fragment: unknown): string[] =>
  [
    ...new Set(
      [...JSON.stringify(fragment ?? {}).matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].toSorted();
const isInstall = (step: Step) => /\bbun install\b/.test(step.run ?? "");
const SCRIPT = "scripts/domain-move-rehearsal.ts";
const OUT = '--out "$RUNNER_TEMP/rehearsal"';

const DEV_ACCOUNT = "${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}";
const DEPLOY_TOKEN = "${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}";
const DEV_DOMAIN = "${{ vars.DEV_DOMAIN }}";

/**
 * The rehearsal's own steps, by the job that runs each, and what each holds:
 * the dev deploy token for a Pages and DNS step (`pages`) or an Alchemy step
 * (`alchemy`), or the job token.
 */
const SCRIPT_STEPS: readonly {
  readonly job: string;
  readonly step: string;
  readonly token: "pages" | "hold" | "alchemy" | "github";
}[] = [
  { job: "setup-pages", step: "preflight", token: "pages" },
  { job: "pages-on", step: "pages-on", token: "pages" },
  { job: "worker-staged", step: "worker-staged", token: "alchemy" },
  { job: "watch", step: "watch", token: "github" },
  { job: "detach", step: "wait-watch", token: "github" },
  { job: "detach", step: "detach", token: "pages" },
  { job: "hold", step: "hold", token: "hold" },
  { job: "flip", step: "flip", token: "alchemy" },
  { job: "check", step: "check", token: "pages" },
  { job: "unflip", step: "unflip", token: "alchemy" },
  { job: "attach", step: "attach", token: "pages" },
  { job: "destroy", step: "destroy", token: "alchemy" },
  { job: "cleanup", step: "cleanup", token: "pages" },
];

const stepId = (step: string) => step.replaceAll("-", "_");
const scriptStep = (job: string, step: string) =>
  stepsOf(job).find((candidate) => candidate.id === stepId(step));

/** What a step holding each token must set, exactly. */
const ENV_OF = {
  pages: {
    DEV_DOMAIN,
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
  hold: {
    DEV_DOMAIN,
    HOLD_MINUTES: "${{ inputs.hold_minutes }}",
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
  alchemy: {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
  github: {
    DEV_DOMAIN,
    GITHUB_TOKEN: "${{ github.token }}",
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
} as const;

/**
 * Whether a job's `if:` lets it run, given the results of the jobs it
 * needs: the expression as GitHub evaluates it, with the implicit
 * `success()` of every need when the expression names no status function.
 */
function runs(job: Job | undefined, results: Readonly<Record<string, string>>): boolean {
  const body = (job?.if ?? "").replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const js = (body === "" ? "true" : body)
    .replaceAll("!cancelled()", "true")
    .replaceAll("always()", "true")
    .replace(/needs\.([a-z-]+)\.result/g, (_, id: string) =>
      JSON.stringify(results[id] ?? "skipped"),
    )
    .replaceAll("'", '"')
    .replace(/!=(?!=)/g, "!==")
    .replace(/(?<![!=])==(?!=)/g, "===");
  const allowed = new Function(`return (${js});`)() as boolean;
  if (/\b(cancelled|always|failure|success)\(\)/.test(body)) return allowed;
  return allowed && needsOf(job).every((id) => (results[id] ?? "success") === "success");
}

/** Runs a step's `run` as GitHub runs one (`bash -e`), with a stand-in `bun` exiting `bunExit`. */
function runStep(step: Step | undefined, bunExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-workflow-step-"));
  const log = join(dir, "bun-calls");
  writeFileSync(join(dir, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit ${bunExit}\n`);
  chmodSync(join(dir, "bun"), 0o755);
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", step?.run ?? ""], {
    cwd: dir,
    env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_RUN_ID: "41818903897" },
  });
  return {
    exitCode: result.exitCode,
    calls: existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.replaceAll(dir, "$RUNNER_TEMP"))
      : [],
  };
}

describe("domain-move-rehearsal.yml", () => {
  test("W1: runs by hand alone, with one input, the hold's minutes, which the script bounds, reading the repository; only watch and detach may read Actions runs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = (workflow.on.workflow_dispatch as { inputs?: Record<string, unknown> } | null)
      ?.inputs;
    expect(Object.keys(inputs ?? {})).toEqual(["hold_minutes"]);
    expect(inputs?.hold_minutes).toMatchObject({
      type: "number",
      required: false,
      default: HOLD_DEFAULT_MINUTES,
    });
    expect((inputs?.hold_minutes as { description?: string } | undefined)?.description).toContain(
      `0 to ${HOLD_MAX_MS / 60_000}`,
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [id, job] of Object.entries(jobs)) {
      expect({ id, permissions: job.permissions }).toEqual({
        id,
        permissions: ["watch", "detach"].includes(id)
          ? { contents: "read", actions: "read" }
          : undefined,
      });
    }
    expect(jobs.watch?.name).toBe(WATCH_JOB_NAME);
    expect(jobs.attach?.name).toBe(ATTACH_JOB_NAME);
  });

  test("W2: one rehearsal at a time, never cancelled by the next, in no deploy job's group", () => {
    expect(workflow.concurrency).toEqual({
      group: "domain-move-rehearsal",
      "cancel-in-progress": false,
    });
    for (const [id, job] of Object.entries(jobs)) {
      expect({ id, concurrency: job.concurrency }).toEqual({ id, concurrency: undefined });
    }
    expect(text).not.toMatch(/deploy-(dev|production)-/);
  });

  test("W3: it reads the dev account's credentials alone, every job in the dev Environment, and names no production zone", () => {
    // The dev deploy token and account id, as deploy.yml's stack jobs read them; no other token.
    expect(secretsIn(workflow)).toEqual([
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
    // DEV_DOMAIN is a dev Environment variable, so even the jobs holding no
    // secret (watch, report) run there to read it.
    for (const [id, job] of Object.entries(jobs)) {
      expect({ id, environment: job.environment }).toEqual({ id, environment: "dev" });
    }
    expect(secretsIn(jobs.watch)).toEqual([]);
    expect(secretsIn(jobs.report)).toEqual([]);
    for (const zone of ["cireweddings.com", "musubi.social", "pulse.events"]) {
      expect(text).not.toContain(zone);
    }
    expect(text).not.toContain("secrets.GITHUB_TOKEN");
  });

  test("W4: each credential reaches only the steps that use it; no job or workflow env holds one, and no job restores a cache", () => {
    expect(secretsIn(workflow.env)).toEqual([]);
    for (const [id, job] of Object.entries(jobs)) {
      expect({ id, env: secretsIn(job.env) }).toEqual({ id, env: [] });
      expect({
        id,
        caches: (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/cache")),
      }).toEqual({
        id,
        caches: [],
      });
    }
    const holding = (secret: string) =>
      Object.entries(jobs).flatMap(([id, job]) =>
        (job.steps ?? [])
          .filter((step) => JSON.stringify(step).includes(`secrets.${secret}`))
          .map((step) => `${id} ${step.id}`),
      );
    const byToken = (token: string) =>
      SCRIPT_STEPS.filter((entry) => entry.token === token).map(
        (entry) => `${entry.job} ${stepId(entry.step)}`,
      );
    // The deploy token: the rehearsal's Cloudflare steps, the Alchemy jobs'
    // token checks, and Wrangler's upload of the marker page; nothing else.
    expect(holding("CLOUDFLARE_DEV_ACCOUNT_API_TOKEN").toSorted()).toEqual(
      [
        ...byToken("pages"),
        ...byToken("hold"),
        ...byToken("alchemy"),
        ...["worker-staged", "flip", "unflip", "destroy"].map((id) => `${id} token`),
        "setup-pages upload",
      ].toSorted(),
    );
    for (const { job, step, token } of SCRIPT_STEPS) {
      expect({ job, step, env: scriptStep(job, step)?.env }).toEqual({
        job,
        step,
        env: ENV_OF[token],
      });
    }
  });

  test("W5: the rehearsed Pages and DNS steps run with nothing installed; setup-pages checks the token's reach before the install that precedes Wrangler", () => {
    for (const id of [
      "pages-on",
      "detach",
      "hold",
      "check",
      "attach",
      "cleanup",
      "watch",
      "report",
    ]) {
      const steps = stepsOf(id);
      expect({ id, installs: steps.filter(isInstall) }).toEqual({ id, installs: [] });
      expect({
        id,
        uses: steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses.split("@")[0]])),
      }).toEqual({
        id,
        uses: [
          "actions/checkout",
          "oven-sh/setup-bun",
          ...(id === "report" ? ["actions/download-artifact"] : []),
          "actions/upload-artifact",
        ],
      });
    }
    const setup = stepsOf("setup-pages");
    const install = setup.findIndex(isInstall);
    expect(setup[install]?.run).toBe("bun install --frozen-lockfile --filter osn");
    const at = (id: string) => setup.findIndex((step) => step.id === id);
    // The preflight's reach check (exactly the dev account and the DEV_DOMAIN
    // zone) is the first step holding the token, before any install.
    const first = setup.findIndex((step) => JSON.stringify(step).includes("secrets."));
    expect(first).toBe(at("preflight"));
    expect(at("preflight")).toBeLessThan(install);
    expect(install).toBeLessThan(at("upload"));
  });

  test("W6: every job holding the deploy token checks it reaches the dev account alone before any other step holds it", () => {
    for (const id of ["worker-staged", "flip", "unflip", "destroy"]) {
      const steps = stepsOf(id);
      const token = steps.findIndex((step) => step.id === "token");
      expect(steps[token]?.run).toBe("bun run --cwd shared/infra token:check -- --tier dev");
      expect(steps[token]?.env).toEqual({
        DEV_DOMAIN,
        CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
        CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
      });
      const first = steps.findIndex((step) => JSON.stringify(step).includes("secrets."));
      expect({ id, first }).toEqual({ id, first: token });
      expect(steps.findIndex(isInstall)).toBeLessThan(token);
      expect(steps.find(isInstall)?.run).toBe(
        "bun install --frozen-lockfile --filter @shared/infra",
      );
    }
  });

  test("W7: the rollback runs after a failed flip once the detach succeeded; destroy, cleanup and report run whatever happened", () => {
    expect(needsOf(jobs.unflip).toSorted()).toEqual(["check", "detach", "flip"]);
    expect(needsOf(jobs.attach).toSorted()).toEqual(["detach", "unflip"]);
    for (const id of ["unflip", "attach"]) {
      for (const flip of ["success", "failure", "skipped"]) {
        expect({
          id,
          flip,
          runs: runs(jobs[id], { detach: "success", flip, check: "skipped", unflip: "failure" }),
        }).toEqual({
          id,
          flip,
          runs: true,
        });
      }
      for (const detach of ["failure", "skipped"]) {
        expect({ id, detach, runs: runs(jobs[id], { detach }) }).toEqual({
          id,
          detach,
          runs: false,
        });
      }
    }
    const before = [
      "setup-pages",
      "worker-staged",
      "pages-on",
      "detach",
      "flip",
      "check",
      "unflip",
      "attach",
    ];
    expect(needsOf(jobs.destroy).toSorted()).toEqual(before.toSorted());
    expect(needsOf(jobs.cleanup).toSorted()).toEqual([...before, "destroy"].toSorted());
    expect(needsOf(jobs.report).toSorted()).toEqual(
      Object.keys(jobs)
        .filter((id) => id !== "report")
        .toSorted(),
    );
    for (const id of ["destroy", "cleanup", "report"]) {
      expect(jobs[id]?.if).toBe("${{ always() }}");
      expect(runs(jobs[id], Object.fromEntries(before.map((need) => [need, "failure"])))).toBe(
        true,
      );
    }
    expect(needsOf(jobs.detach).toSorted()).toEqual(["pages-on", "worker-staged"]);
    // The host stays detached for the hold before the flip's deploy.
    expect(needsOf(jobs.hold)).toEqual(["detach"]);
    expect(needsOf(jobs.flip)).toEqual(["hold"]);
    expect(needsOf(jobs.check)).toEqual(["flip"]);
    expect(needsOf(jobs.watch)).toEqual(["pages-on"]);
  });

  test("W8: every job keeps its record whatever happened, under the attempt; report keeps the merged one", () => {
    for (const id of Object.keys(jobs).filter((candidate) => candidate !== "report")) {
      const upload = stepsOf(id).filter((step) => step.uses === "actions/upload-artifact@v4");
      expect({ id, upload: upload.map((step) => [step.if, step.with]) }).toEqual({
        id,
        upload: [
          [
            "${{ always() }}",
            {
              name: `rehearsal-${id}-attempt-\${{ github.run_attempt }}`,
              path: "${{ runner.temp }}/rehearsal/",
              "retention-days": 90,
            },
          ],
        ],
      });
    }
    const report = stepsOf("report");
    expect(report.find((step) => step.uses === "actions/download-artifact@v4")?.with).toEqual({
      pattern: "rehearsal-*-attempt-${{ github.run_attempt }}",
      "merge-multiple": true,
      path: "${{ runner.temp }}/rehearsal",
    });
    const kept = report.find((step) => step.uses === "actions/upload-artifact@v4");
    expect([kept?.if, kept?.with]).toEqual([
      "${{ always() }}",
      {
        name: "domain-move-rehearsal-attempt-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/rehearsal/domain-move-rehearsal.json",
        "retention-days": 90,
      },
    ]);
  });

  test("W9: each of the rehearsal's steps runs the script with its own name, and fails its job when the script fails", () => {
    const all = [...SCRIPT_STEPS, { job: "report", step: "report", token: "none" }];
    for (const { job, step } of all) {
      const found = scriptStep(job, step);
      expect({ job, step, run: found?.run }).toEqual({
        job,
        step,
        run: `bun run ${SCRIPT} ${step} ${OUT}`,
      });
      expect(runStep(found).calls).toEqual([`run ${SCRIPT} ${step} --out $RUNNER_TEMP/rehearsal`]);
      expect(runStep(found, 1).exitCode).not.toBe(0);
    }
    // No other step runs the script.
    const running = Object.values(jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.run?.includes(SCRIPT)),
    );
    expect(running).toHaveLength(all.length);
  });

  test("W9a: the report reads every job's own result, and the script maps each job to the steps it runs", () => {
    const merge = scriptStep("report", "report");
    expect(merge?.env).toEqual({
      DEV_DOMAIN,
      REHEARSAL_JOBS: "${{ toJSON(needs) }}",
    });
    // No job hands the report an output, so the jobs' results are all it reads.
    expect(
      Object.entries(jobs)
        .filter(([, job]) => "outputs" in job)
        .map(([id]) => id),
    ).toEqual([]);
    const fromWorkflow: Record<string, string[]> = {};
    for (const { job, step } of SCRIPT_STEPS) (fromWorkflow[job] ??= []).push(step);
    expect(JOB_STEPS as Readonly<Record<string, readonly string[]>>).toEqual(fromWorkflow);
    expect(Object.keys(JOB_STEPS).toSorted()).toEqual(
      Object.keys(jobs)
        .filter((id) => id !== "report")
        .toSorted(),
    );
  });

  test("W10: Wrangler uploads the marker page to the run's own project, on its production branch", () => {
    const upload = stepsOf("setup-pages").find((step) => step.id === "upload");
    expect(upload?.run).toBe(
      'bunx wrangler pages deploy shared/infra/rehearsal/pages --project-name "osn-move-rehearsal-$GITHUB_RUN_ID" --branch main --commit-dirty=true',
    );
    expect(upload?.env).toEqual({
      CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
      CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
    });
  });

  test("W11: the move itself runs only on success; the detach waits for the watch first; each job outlasts the waits its step can make", () => {
    // The detach, flip and check run only once everything before them passed.
    for (const id of ["detach", "hold", "flip", "check"]) {
      expect({ id, if: jobs[id]?.if }).toEqual({ id, if: undefined });
    }
    const detach = stepsOf("detach");
    const waitAt = detach.findIndex((step) => step.id === "wait_watch");
    expect(waitAt).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(detach.findIndex((step) => step.id === "detach"));
    // A job its timeout kills mid-wait records the wait as cut short, not as Cloudflare's answer.
    const minutes = (ms: number) => ms / 60_000;
    const longest: Readonly<Record<string, number>> = {
      "pages-on": minutes(PIN_TIMEOUT_MS + PAGES_WAIT_MS),
      attach: minutes(PIN_TIMEOUT_MS + PAGES_WAIT_MS),
      "worker-staged": minutes(PIN_TIMEOUT_MS + WORKER_WAIT_MS),
      flip: minutes(PIN_TIMEOUT_MS + WORKER_WAIT_MS),
      unflip: minutes(PIN_TIMEOUT_MS + WORKER_WAIT_MS),
      watch: minutes(PIN_TIMEOUT_MS + WATCH_CAP_MS),
      detach: minutes(WAIT_WATCH_CAP_MS),
      hold: minutes(HOLD_MAX_MS) + 1,
    };
    for (const [id, wait] of Object.entries(longest)) {
      const timeout = jobs[id]?.["timeout-minutes"] ?? 0;
      expect({ id, outlasts: timeout > wait }).toEqual({ id, outlasts: true });
    }
  });

  test("every checkout leaves the job token off the disk", () => {
    for (const [id, job] of Object.entries(jobs)) {
      for (const step of (job.steps ?? []).filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      )) {
        expect({ id, with: step.with }).toEqual({ id, with: { "persist-credentials": false } });
      }
    }
  });
});
