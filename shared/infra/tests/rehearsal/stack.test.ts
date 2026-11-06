// The rehearsal stack (rehearsal/alchemy.run.ts), evaluated offline as
// `alchemy plan` evaluates it: in-memory state and no Cloudflare call. It
// must declare the one marker Worker at the host REHEARSAL_MODE names, and
// refuse to run anywhere but the dev tier's `domain-move` stage.
import * as Alchemy from "alchemy";
import { afterAll, describe, expect, test } from "vitest";

import { rehearsalStack } from "../../rehearsal/alchemy.run";
import { REHEARSAL_WORKER, RehearsalNameError } from "../../rehearsal/names";
import { DeployTargetError, StageNotDeclaredError } from "../../src/target";
import {
  DEV_DOMAIN,
  evaluateStack,
  failureOf,
  offlineStackOptions,
  removeEvaluations,
  resourcesOf,
} from "../support/evaluate-stack";

afterAll(removeEvaluations);

const env = (extra: Record<string, string | undefined> = {}) => ({
  DEV_DOMAIN,
  OSN_DEPLOY_TIER: "dev",
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  CLOUDFLARE_API_TOKEN: "placeholder-token",
  REHEARSAL_MODE: "staged",
  ...extra,
});

const evaluate = (stage: string, stackEnv: Record<string, string | undefined>) =>
  evaluateStack({
    stage,
    sites: {},
    stack: ({ workingDir }) =>
      Alchemy.Stack(
        "domain-move-rehearsal",
        offlineStackOptions(),
        rehearsalStack({ env: stackEnv, workingDir }),
      ),
  });

describe("the rehearsal stack, evaluated offline", () => {
  test("K1: declares the one marker Worker on the spare host when staged and on the moved host as worker", async () => {
    for (const [mode, domain] of [
      ["staged", `next.domain-move.${DEV_DOMAIN}`],
      ["worker", `domain-move.${DEV_DOMAIN}`],
    ] as const) {
      const evaluation = await evaluate("domain-move", env({ REHEARSAL_MODE: mode }));
      const resources = resourcesOf(evaluation);
      expect(evaluation.fetches).toEqual([]);
      expect(Object.keys(resources)).toEqual(["RehearsalSite"]);
      const site = resources.RehearsalSite;
      expect({ name: site?.Props.name, domain: site?.Props.domain }).toEqual({
        name: REHEARSAL_WORKER,
        domain,
      });
      // Destroyed with the stage, as every investigation stage's Worker.
      expect(site?.RemovalPolicy).not.toBe("retain");
    }
  });

  test("K2: refuses any stage but domain-move, and the production tier", async () => {
    expect(failureOf(await evaluate("dev", env()))).toBeInstanceOf(RehearsalNameError);
    expect(failureOf(await evaluate("pr-7", env()))).toBeInstanceOf(RehearsalNameError);
    expect(
      failureOf(await evaluate("production", env({ OSN_DEPLOY_TIER: "production" }))),
    ).toBeInstanceOf(StageNotDeclaredError);
  });

  test("K3: refuses a missing or unknown REHEARSAL_MODE, and a deploy tier that is not dev", async () => {
    for (const mode of [undefined, "", "flip"]) {
      expect(
        failureOf(await evaluate("domain-move", env({ REHEARSAL_MODE: mode }))),
      ).toBeInstanceOf(RehearsalNameError);
    }
    expect(
      failureOf(await evaluate("domain-move", env({ OSN_DEPLOY_TIER: "production" }))),
    ).toBeInstanceOf(DeployTargetError);
  });
});
