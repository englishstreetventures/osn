// Holds .github/workflows/deploy.yml to the dev-hosts command: every
// `steps.hosts.outputs.<key>` a dev build or smoke check reads is one the
// command writes. GitHub expands an output nobody wrote to an empty string,
// so a misspelt key builds a site against no API origin, or fails a smoke
// check, with nothing pointing at the typo.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { devHostOutputs } from "../src/hosts";

interface Step {
  readonly id?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Workflow {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT = readFileSync(`${ROOT}.github/workflows/deploy.yml`, "utf8");
const workflow = Bun.YAML.parse(TEXT) as Workflow;

const HOST_READ = /\bsteps\.hosts\.outputs\.([A-Za-z0-9_]+)/g;
const hostKeysRead = (fragment: unknown): string[] =>
  [...JSON.stringify(fragment ?? {}).matchAll(HOST_READ)].map((match) => match[1] ?? "");

/** A domain the dev layout accepts; the keys do not depend on it. */
const DOMAIN = "dev-zone.example";

describe("the dev-hosts outputs deploy.yml reads", () => {
  test("every one is a key devHostOutputs() writes", () => {
    const read = [...new Set([...TEXT.matchAll(HOST_READ)].map((match) => match[1] ?? ""))];
    expect(read.length).toBeGreaterThan(0);
    const written = new Set(devHostOutputs(DOMAIN, "dev").keys());
    expect(read.filter((key) => !written.has(key)).toSorted()).toEqual([]);
  });

  test("each job that reads one runs the dev-hosts step, for dev, before the first read", () => {
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
      }).toEqual({
        id,
        run: "bun run --cwd shared/infra dev-hosts -- --stage dev",
        env: { DEV_DOMAIN: "${{ vars.DEV_DOMAIN }}" },
        readsAfter: true,
      });
    }
  });

  test("the dev-hosts step, run as the workflow runs it, writes every key the workflow reads", () => {
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
    expect(written).toEqual(new Map(devHostOutputs(DOMAIN, "dev")));
    const read = [...new Set([...TEXT.matchAll(HOST_READ)].map((match) => match[1] ?? ""))];
    expect(read.filter((key) => !written.has(key))).toEqual([]);
  });
});
