import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { tierSecrets } from "@shared/infra";
import * as Alchemy from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import * as Cloudflare from "alchemy/Cloudflare";
import { layerNonInteractive } from "alchemy/Interaction";
import { evalStack } from "alchemy/Stack";
import { Cause, Effect, Exit, Layer } from "effect";

import { cireStack } from "../alchemy.run";

export const DEV_DOMAIN = "example.test";

/** The temporary directories evaluations wrote into, removed by `removeEvaluations`. */
const roots: string[] = [];

/** Removes every directory an evaluation in this file wrote into. */
export function removeEvaluations(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * Everything the cire deploy step's environment holds, with placeholder
 * values: the deploy target, the dev domain and every secret the inventory
 * declares for cire-api and cire-invites on dev (required and optional).
 * STRIPE_SECRET_KEY is a test-mode key, as the dev tier requires.
 * `CIRE_DEV_OWNER_PROFILE_ID` is left unset; a test sets it.
 */
export function stackEnv(): Record<string, string | undefined> {
  const rows = [tierSecrets("cire-api", "dev"), tierSecrets("cire-invites", "dev")];
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
    ...Object.fromEntries(
      rows
        .flatMap((row) => row.secrets.concat(row.optional))
        .map((name) => [name, `placeholder-${name}`]),
    ),
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  };
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
  readonly generatedDir: string;
}

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
 * Evaluates the cire stack body the way `alchemy plan` does, with in-memory
 * state and no Cloudflare call: `fetch` is replaced for the duration by one
 * that records the URL and throws.
 */
export async function evaluateCire(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Evaluation> {
  const root = mkdtempSync(join(tmpdir(), "cire-infra-"));
  roots.push(root);
  const generatedDir = join(root, ".generated");
  const stack = Alchemy.Stack(
    "cire",
    { providers: Cloudflare.providers(), state: Alchemy.inMemoryState() },
    cireStack({ env: input.env, generatedDir }),
  );
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
      generatedDir,
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
