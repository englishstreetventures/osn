// Holds .github/workflows/domain-move-rehearsal.yml to what makes it safe to
// dispatch: it reaches the dev account alone, each credential reaches only
// the steps that use it, the rehearsed steps that hold the Pages and DNS
// token run with nothing installed (as production's detach and attach jobs
// do), the rollback runs after a failed flip, and the cleanup runs whatever
// happened before it, cancellation included.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ATTACH_JOB_NAME, WATCH_JOB_NAME } from "../domain-move-rehearsal";

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
const DNS_TOKEN = "${{ secrets.CLOUDFLARE_DEV_PAGES_DNS_TOKEN }}";
const UPLOAD_TOKEN = "${{ secrets.CLOUDFLARE_DEV_PAGES_UPLOAD_TOKEN }}";
const DEV_DOMAIN = "${{ vars.DEV_DOMAIN }}";

/** The rehearsal's own steps, by the job that runs each, and which token each holds. */
const SCRIPT_STEPS: readonly {
  readonly job: string;
  readonly step: string;
  readonly token: "dns" | "deploy" | "upload" | "github";
}[] = [
  { job: "setup-pages", step: "upload-reach", token: "upload" },
  { job: "setup-pages", step: "preflight", token: "dns" },
  { job: "pages-on", step: "pages-on", token: "dns" },
  { job: "worker-staged", step: "worker-staged", token: "deploy" },
  { job: "watch", step: "watch", token: "github" },
  { job: "detach", step: "wait-watch", token: "github" },
  { job: "detach", step: "detach", token: "dns" },
  { job: "flip", step: "flip", token: "deploy" },
  { job: "check", step: "check", token: "dns" },
  { job: "unflip", step: "unflip", token: "deploy" },
  { job: "attach", step: "attach", token: "dns" },
  { job: "destroy", step: "destroy", token: "deploy" },
  { job: "cleanup", step: "cleanup", token: "dns" },
];

const stepId = (step: string) => step.replaceAll("-", "_");
const scriptStep = (job: string, step: string) =>
  stepsOf(job).find((candidate) => candidate.id === stepId(step));

/** What a step holding each token must set, exactly. */
const ENV_OF = {
  dns: {
    DEV_DOMAIN,
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_PAGES_DNS_TOKEN: DNS_TOKEN,
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
  deploy: {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
    BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS: "1",
  },
  upload: {
    DEV_DOMAIN,
    CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
    CLOUDFLARE_API_TOKEN: UPLOAD_TOKEN,
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
  test("W1: runs by hand alone, with no input, reading the repository; only watch and detach may read Actions runs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
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
    expect(secretsIn(workflow)).toEqual([
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
      "CLOUDFLARE_DEV_PAGES_DNS_TOKEN",
      "CLOUDFLARE_DEV_PAGES_UPLOAD_TOKEN",
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
    expect(holding("CLOUDFLARE_DEV_PAGES_DNS_TOKEN").toSorted()).toEqual(byToken("dns").toSorted());
    expect(holding("CLOUDFLARE_DEV_PAGES_UPLOAD_TOKEN").toSorted()).toEqual(
      ["setup-pages upload", ...byToken("upload")].toSorted(),
    );
    expect(holding("CLOUDFLARE_DEV_ACCOUNT_API_TOKEN").toSorted()).toEqual(
      [
        ...byToken("deploy"),
        ...["worker-staged", "flip", "unflip", "destroy"].map((id) => `${id} token`),
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

  test("W5: the rehearsed steps that hold the Pages and DNS token run with nothing installed; setup-pages checks both Pages tokens before its install", () => {
    for (const id of ["pages-on", "detach", "check", "attach", "cleanup", "watch", "report"]) {
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
    expect(at("upload_reach")).toBeGreaterThan(-1);
    expect(at("upload_reach")).toBeLessThan(at("preflight"));
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
    expect(needsOf(jobs.flip)).toEqual(["detach"]);
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

  test("W10: Wrangler uploads the marker page to the run's own project, on its production branch", () => {
    const upload = stepsOf("setup-pages").find((step) => step.id === "upload");
    expect(upload?.run).toBe(
      'bunx wrangler pages deploy shared/infra/rehearsal/pages --project-name "osn-move-rehearsal-$GITHUB_RUN_ID" --branch main --commit-dirty=true',
    );
    expect(upload?.env).toEqual({
      CLOUDFLARE_ACCOUNT_ID: DEV_ACCOUNT,
      CLOUDFLARE_API_TOKEN: UPLOAD_TOKEN,
    });
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
