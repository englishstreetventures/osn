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

import { musubiStack } from "../alchemy.run";

export const DEV_DOMAIN = "example.test";

/** The temporary directories evaluations wrote into, removed by `removeEvaluations`. */
const roots: string[] = [];

/** Removes every directory an evaluation in this file wrote into. */
export function removeEvaluations(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const ARC_KEY_ID = "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f";
export const OIDC_CLIENT_SECRET = "cs_placeholder-client-secret";

/** A fresh ES256 private key as the raw JWK string cire-api holds in CIRE_API_ARC_PRIVATE_KEY. */
export async function generateArcPrivateJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/**
 * Everything the musubi deploy step's environment holds, with placeholder
 * values: the deploy target, the dev domain, every secret the inventory
 * declares for osn-api on dev (required and optional), and the three seed
 * secrets.
 */
export function stackEnv(arcPrivateJwk: string): Record<string, string | undefined> {
  const row = tierSecrets("osn-api", "dev");
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
    ...Object.fromEntries(
      [...row.secrets, ...row.optional].map((name) => [name, `placeholder-${name}`]),
    ),
    CIRE_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
    CIRE_API_ARC_KEY_ID: ARC_KEY_ID,
    CIRE_API_ARC_PRIVATE_KEY: arcPrivateJwk,
  };
}

/** What the tests read from an evaluated resource. */
export interface EvaluatedResource {
  readonly Type: string;
  readonly LogicalId: string;
  readonly RemovalPolicy: string;
  readonly Props: Cloudflare.WorkerProps & Cloudflare.D1.DatabaseProps;
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
 * Evaluates the musubi stack body the way `alchemy plan` does, with
 * in-memory state and no Cloudflare call: `fetch` is replaced for the
 * duration by one that records the URL and throws.
 */
export async function evaluateMusubi(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Evaluation> {
  const root = mkdtempSync(join(tmpdir(), "musubi-infra-"));
  roots.push(root);
  const generatedDir = join(root, ".generated");
  const stack = Alchemy.Stack(
    "musubi",
    { providers: Cloudflare.providers(), state: Alchemy.inMemoryState() },
    musubiStack({ env: input.env, generatedDir }),
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
