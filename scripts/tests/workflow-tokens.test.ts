// Holds what the workflows' job token may do and where it may be left.
//
// `actions/checkout` writes the job token into the checkout's .git/config
// unless `persist-credentials: false`, and every later step of the job can
// read it there. The workflows listed below never push or fetch after their
// checkouts, so none of their checkouts may leave it behind.
// production-release.yml is held to the same in deploy-workflows.test.ts.
//
// A workflow that names no `permissions` gets the repository's default token
// rights, which the workflow file cannot see; each workflow names them, at the
// top or on every job.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Step {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly permissions?: unknown;
  readonly jobs: Readonly<
    Record<string, { readonly permissions?: unknown; readonly steps?: readonly Step[] }>
  >;
}

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");
const load = (file: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

const NO_TOKEN_ON_DISK = [
  "alchemy-state.yml",
  "ci-swift.yml",
  "cire-d1-latency-probe.yml",
  "free-tier-ceiling-alert.yml",
  "main-audit.yml",
  "migration-history.yml",
];

test.each(NO_TOKEN_ON_DISK)("%s: no checkout leaves the job token in .git/config", (file) => {
  const checkouts = Object.entries(load(file).jobs).flatMap(([job, { steps }]) =>
    (steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/checkout@") === true)
      .map((step) => ({ job, persist: step.with?.["persist-credentials"] })),
  );
  expect(checkouts.length).toBeGreaterThan(0);
  expect(checkouts).toEqual(checkouts.map(({ job }) => ({ job, persist: false })));
});

test("every workflow names its token's permissions, at the top or on every job", () => {
  const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));
  expect(files.length).toBeGreaterThan(0);
  const unnamed = files.filter((file) => {
    const workflow = load(file);
    return (
      workflow.permissions === undefined &&
      Object.values(workflow.jobs).some((job) => job.permissions === undefined)
    );
  });
  expect(unnamed).toEqual([]);
});

test("ci-swift.yml reads the repository and nothing else", () => {
  const workflow = load("ci-swift.yml");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual(
    Object.values(workflow.jobs).map(() => undefined),
  );
});
