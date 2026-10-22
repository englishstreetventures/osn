import { join } from "node:path";

import {
  assertDevDeployTarget,
  assertSiteBuiltFor,
  assertStackRetained,
  readDevDomain,
  refuseDotEnvFiles,
  siteWorker,
  stackOptions,
  stageHosts,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import { pulseDeclaration } from "./src/declaration";

/**
 * The pulse stack: pulse landing, served by a Worker that answers
 * `GET /api/geo` beside the site's static assets. It holds no secret and
 * writes no file; every value is checked, and the site's build output is
 * checked to be built for the stage's host, before anything is declared.
 * Paths are relative to the working directory, `pulse/infra`. `workingDir`
 * names that directory to the checks: the `.env` files Bun would load from
 * it are refused, and the site path resolves from it.
 */
export const pulseStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const { env } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
    const declared = pulseDeclaration({ stage, hosts });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.workingDir, site.directory) });
    }

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const landing = yield* siteWorker("PulseLanding", declared.pulseLanding);
    assertStackRetained({ stage, storage: [], workers: [landing] });
    return { pulseLanding: hosts.pulseLanding };
  });

export default Alchemy.Stack(
  "pulse",
  stackOptions(),
  pulseStack({ env: process.env, workingDir: process.cwd() }),
);
