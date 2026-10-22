import { tierSecrets } from "@shared/infra";
import * as Alchemy from "alchemy";

import {
  DEV_DOMAIN,
  evaluateStack,
  offlineStackOptions,
  stageSites,
  type Evaluation,
  type SiteFixtures,
} from "../../../shared/infra/tests/support/evaluate-stack";
import { musubiStack } from "../alchemy.run";

export {
  DEV_DOMAIN,
  failureOf,
  removeEvaluations,
  resourcesOf,
  type EvaluatedResource,
  type Evaluation,
  type SiteFixtures,
} from "../../../shared/infra/tests/support/evaluate-stack";

export const ARC_KEY_ID = "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f";
/** SHA-256("abc"): a hash of the shape the cire_seed step writes for the client secret. */
export const OIDC_CLIENT_SECRET_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** A fresh ES256 public key as the cire_seed step writes it: kty, crv, x and y only. */
export async function generateArcPublicJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return JSON.stringify({ kty, crv, x, y });
}

/**
 * Everything the musubi deploy step's environment holds, with placeholder
 * values: the deploy target, the dev domain, every secret the inventory
 * declares for osn-api on dev (required and optional), DEV_LOGIN_SECRET at
 * the length the dev tier requires, and the three seed values the cire_seed
 * step derives. No cire secret: the step holds none.
 */
export function stackEnv(arcPublicJwk: string): Record<string, string | undefined> {
  const row = tierSecrets("osn-api", "dev");
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
    ...Object.fromEntries(
      [...row.secrets, ...row.optional].map((name) => [name, `placeholder-${name}`]),
    ),
    DEV_LOGIN_SECRET: "placeholder-DEV_LOGIN_SECRET-of-32-characters-or-more",
    CIRE_API_ARC_KEY_ID: ARC_KEY_ID,
    CIRE_API_ARC_PUBLIC_JWK: arcPublicJwk,
    CIRE_OIDC_CLIENT_SECRET_SHA256: OIDC_CLIENT_SECRET_SHA256,
  };
}

/** The prebuilt site directories the stack uploads, under `musubi/`. */
export const SITE_DIRECTORIES: readonly string[] = ["social/dist", "landing/dist"];

/**
 * Evaluates the musubi stack body offline at `stage` with `env`. Site output
 * defaults to every origin of the stage's hosts in each of SITE_DIRECTORIES.
 */
export function evaluateMusubi(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sites?: SiteFixtures;
  readonly workingDirFiles?: readonly string[];
}): Promise<Evaluation> {
  return evaluateStack({
    stage: input.stage,
    sites: input.sites ?? stageSites(SITE_DIRECTORIES, input.stage, input.env),
    workingDirFiles: input.workingDirFiles,
    stack: ({ generatedDir, workingDir }) =>
      Alchemy.Stack(
        "musubi",
        offlineStackOptions(),
        musubiStack({ env: input.env, generatedDir, workingDir }),
      ),
  });
}
