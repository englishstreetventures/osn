// Holds .github/workflows/deploy.yml (dev) and production-release.yml
// (production) to the surface map in scripts/deploy-surfaces.ts.
//
// Three things here are load-bearing and invisible to every other gate:
//   - each deploy job gates on its own surface's output. A copy-paste slip
//     that gates one surface on another's output passes actionlint and leaves
//     a surface that never deploys;
//   - each job's name matches the map, because the release planner finds the
//     commit a surface last deployed by the name of the job that deployed it;
//   - every production job needs exactly [plan, build], so they all reach the
//     approval gate together and one review releases them. A job that reached
//     the gate later would need a review of its own.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SURFACES, WORKFLOW_FILE } from "../deploy-surfaces";

interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: string | { readonly name: string };
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress"?: boolean };
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Record<string, Job>;
}

const root = join(import.meta.dir, "..", "..");
const load = (path: string) => Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Workflow;
const dev = load(WORKFLOW_FILE.dev);
const production = load(WORKFLOW_FILE.production);

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
