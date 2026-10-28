// Holds every workflow that reads a host from a step to the command that
// writes it: every `steps.hosts.outputs.<key>` a dev build, smoke check or
// probe reads is one the dev-hosts command writes, and every one a production
// stack job's smoke check reads is one production-hosts writes. GitHub expands
// an output nobody wrote to an empty string, so a misspelt key builds a site
// against no API origin, fails a smoke check, or probes nothing, with nothing
// pointing at the typo.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { devHostOutputs } from "../src/hosts";
import { productionHostOutputs } from "../src/production-sites";

interface Step {
  readonly id?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Workflow {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOWS = `${ROOT}.github/workflows/`;

const HOST_READ = /\bsteps\.hosts\.outputs\.([A-Za-z0-9_]+)/g;

/** Every workflow file that reads a dev-hosts output, sorted. */
const READERS = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .filter((file) => /\bsteps\.hosts\.outputs\./.test(readFileSync(`${WORKFLOWS}${file}`, "utf8")))
  .toSorted();
const hostKeysRead = (fragment: unknown): string[] =>
  [...JSON.stringify(fragment ?? {}).matchAll(HOST_READ)].map((match) => match[1] ?? "");

/** A domain the dev layout accepts; the keys do not depend on it. */
const DOMAIN = "dev-zone.example";

/** The step each reader runs to write the hosts it reads, and what it writes. */
const DEV_HOSTS = {
  run: "bun run --cwd shared/infra dev-hosts -- --stage dev",
  env: { DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" },
  outputs: () => devHostOutputs(DOMAIN, "dev"),
};
const HOST_STEPS: Readonly<Record<string, typeof DEV_HOSTS | ProductionHosts>> = {
  "cire-d1-latency-probe.yml": DEV_HOSTS,
  "deploy.yml": DEV_HOSTS,
  "production-release.yml": {
    run: "bun run --cwd shared/infra production-hosts",
    env: undefined,
    outputs: () => productionHostOutputs(),
  },
};
interface ProductionHosts {
  readonly run: string;
  readonly env: undefined;
  readonly outputs: () => ReadonlyMap<string, string>;
}

test("the workflows that read a host are the deploy, the cire latency probe and the production release", () => {
  expect(READERS).toEqual(Object.keys(HOST_STEPS).toSorted());
});

describe.each(READERS)("the host outputs %s reads", (file) => {
  const TEXT = readFileSync(`${WORKFLOWS}${file}`, "utf8");
  const workflow = Bun.YAML.parse(TEXT) as Workflow;
  const hosts = HOST_STEPS[file]!;

  test("every one is a key its hosts command writes", () => {
    const read = [...new Set([...TEXT.matchAll(HOST_READ)].map((match) => match[1] ?? ""))];
    expect(read.length).toBeGreaterThan(0);
    const written = new Set(hosts.outputs().keys());
    expect(read.filter((key) => !written.has(key)).toSorted()).toEqual([]);
  });

  test("each job that reads one runs the hosts step before the first read", () => {
    const readers = Object.entries(workflow.jobs).filter(([, job]) => hostKeysRead(job).length > 0);
    expect(readers.length).toBeGreaterThan(0);
    for (const [id, job] of readers) {
      const steps = job.steps ?? [];
      const at = steps.findIndex((step) => step.id === "hosts");
      const firstRead = steps.findIndex((step) => hostKeysRead(step).length > 0);
      expect({
        id,
        run: steps[at]?.run,
        env: steps[at]?.env,
        readsAfter: at > -1 && firstRead > at,
      }).toEqual({ id, run: hosts.run, env: hosts.env, readsAfter: true });
    }
  });

  test("the hosts step, run as the workflow runs it, writes every key the workflow reads", () => {
    const step = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((candidate) => candidate.id === "hosts");
    const dir = mkdtempSync(join(tmpdir(), "workflow-hosts-"));
    const output = join(dir, "output");
    writeFileSync(output, "");
    const run = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", step?.run ?? ""], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", DEV_DOMAIN: DOMAIN, GITHUB_OUTPUT: output },
    });
    expect(run.exitCode).toBe(0);
    const written = new Map(
      readFileSync(output, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): [string, string] => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    expect(written).toEqual(new Map(hosts.outputs()));
    const read = [...new Set([...TEXT.matchAll(HOST_READ)].map((match) => match[1] ?? ""))];
    expect(read.filter((key) => !written.has(key))).toEqual([]);
  });
});
