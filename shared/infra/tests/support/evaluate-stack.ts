/**
 * Evaluates a stack body offline the way `alchemy plan` does, for each
 * stack's tests (`<product>/infra/tests/evaluate.ts` imports this by relative
 * path): in-memory state, site output written as fixtures, and no Cloudflare
 * call.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import * as Alchemy from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import * as Cloudflare from "alchemy/Cloudflare";
import { layerNonInteractive } from "alchemy/Interaction";
import { evalStack } from "alchemy/Stack";
import { Cause, Effect, Exit, Layer } from "effect";

import { origin, stageHosts } from "../../src/hosts";

/** The dev domain every stack evaluation runs under. */
export const DEV_DOMAIN = "example.test";

/** The temporary directories evaluations wrote into, removed by `removeEvaluations`. */
const roots: string[] = [];

/** Removes every directory an evaluation in this test file wrote into. */
export function removeEvaluations(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * Site output for an evaluation: each directory under the product's folder
 * (`social/dist`, `invites/dist/client`) mapped to the origins its one file
 * holds.
 */
export type SiteFixtures = Readonly<Record<string, readonly string[]>>;

/**
 * Every origin of the stage's hosts under the env's DEV_DOMAIN (or
 * DEV_DOMAIN) in each of `directories`, as a build for the stage would bake
 * in; none when the host layout refuses the stage or the domain, so the
 * evaluation reaches the stack's own refusal.
 */
export function stageSites(
  directories: readonly string[],
  stage: string,
  env: Readonly<Record<string, string | undefined>>,
): SiteFixtures {
  try {
    const origins = Object.values(stageHosts(env.DEV_DOMAIN ?? DEV_DOMAIN, stage)).map(origin);
    return Object.fromEntries(directories.map((directory) => [directory, origins]));
  } catch {
    return {};
  }
}

/** Writes each fixture as `<root>/<directory>/index.html`, holding its origins. */
function writeSites(root: string, sites: SiteFixtures): void {
  for (const [directory, origins] of Object.entries(sites)) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "index.html"), origins.join("\n"));
  }
}

/** What the tests read from an evaluated resource. */
export interface EvaluatedResource {
  readonly Type: string;
  readonly LogicalId: string;
  readonly RemovalPolicy: string;
  readonly Props: Cloudflare.WorkerProps & Cloudflare.D1.DatabaseProps & Cloudflare.R2.BucketProps;
}

export interface Evaluation {
  readonly exit: Exit.Exit<Readonly<Record<string, EvaluatedResource>>, unknown>;
  /** Every URL the evaluation tried to fetch; each attempt was refused. */
  readonly fetches: readonly string[];
  /** Where the stack was told to write its migrations and seeds. */
  readonly generatedDir: string;
}

/** The directories an evaluation hands the stack body, each under a fresh temporary root. */
export interface StackDirectories {
  readonly generatedDir: string;
  /**
   * The stack's working directory, as the CLI's would be: `<root>/infra`,
   * so the stack's `../social/dist` and the like land on the site fixtures
   * under `<root>`.
   */
  readonly workingDir: string;
}

/** What `alchemy/Stack`'s `evalStack` takes: a stack built with `Alchemy.Stack`. */
type CompiledStackEffect = Parameters<typeof evalStack>[0];

/** The stack options for an offline evaluation: Cloudflare's providers and in-memory state. */
export const offlineStackOptions = () => ({
  providers: Cloudflare.providers(),
  state: Alchemy.inMemoryState(),
});

/**
 * What the CLI supplies around a stack (`alchemy/Cli/main.ts`, `alchemy/Test/Core.ts`):
 * the `.alchemy` directory, the platform, a state store, no prompts and an
 * artifact store. The stack's own layers replace the state store with the
 * one it declares.
 */
const cliServices = Layer.mergeAll(
  AlchemyContextLive,
  Alchemy.inMemoryState(),
  layerNonInteractive(),
).pipe(Layer.provideMerge(BunServices.layer));

/**
 * Evaluates `stack` at `stage` with the site output `sites` and, in its
 * working directory, an empty file for each name in `workingDirFiles`. `fetch`
 * is replaced for the duration by one that records the URL and throws.
 */
export async function evaluateStack(input: {
  readonly stage: string;
  readonly stack: (directories: StackDirectories) => CompiledStackEffect;
  readonly sites: SiteFixtures;
  readonly workingDirFiles?: readonly string[];
}): Promise<Evaluation> {
  const root = mkdtempSync(join(tmpdir(), "stack-evaluation-"));
  roots.push(root);
  const directories = { generatedDir: join(root, ".generated"), workingDir: join(root, "infra") };
  writeSites(root, input.sites);
  if (input.workingDirFiles !== undefined && input.workingDirFiles.length > 0) {
    mkdirSync(directories.workingDir, { recursive: true });
    for (const name of input.workingDirFiles) writeFileSync(join(directories.workingDir, name), "");
  }
  const stack = input.stack(directories);
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (request: string | URL | Request): Promise<Response> => {
      fetches.push(request instanceof Request ? request.url : String(request));
      return Promise.reject(new Error("the stack evaluation test makes no network call"));
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const exit = await Effect.runPromiseExit(
      evalStack(stack, (compiled) => Effect.succeed(compiled.resources), {
        stage: input.stage,
      }).pipe(provideFreshArtifactStore, Effect.provide(cliServices)),
    );
    return {
      exit: Exit.map(exit, (resources) => resources as Record<string, EvaluatedResource>),
      fetches,
      generatedDir: directories.generatedDir,
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The resources of a successful evaluation; fails the test with the cause otherwise. */
export function resourcesOf(evaluation: Evaluation): Readonly<Record<string, EvaluatedResource>> {
  if (Exit.isFailure(evaluation.exit)) {
    throw new Error(`the stack did not evaluate:\n${Cause.pretty(evaluation.exit.cause)}`);
  }
  return evaluation.exit.value;
}

/** The error or defect a failed evaluation ended with. */
export function failureOf(evaluation: Evaluation): unknown {
  if (Exit.isSuccess(evaluation.exit)) throw new Error("the stack evaluated; expected a refusal");
  return Cause.squash(evaluation.exit.cause);
}
