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
 * Paths are relative to the working directory, `pulse/infra`; `siteRoot` is
 * the directory the site path resolves from for that check, the working
 * directory when the CLI runs the stack.
 */
export const pulseStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly siteRoot: string;
}) =>
  Effect.gen(function* () {
    const { env } = input;
    refuseDotEnvFiles(process.cwd());
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
    const declared = pulseDeclaration({ stage, hosts });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.siteRoot, site.directory) });
    }

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const landing = yield* siteWorker("PulseLanding", declared.pulseLanding);
    assertStackRetained({ stage, storage: [], workers: [landing] });
    return { pulseLanding: hosts.pulseLanding };
  });

export default Alchemy.Stack(
  "pulse",
  stackOptions(),
  pulseStack({ env: process.env, siteRoot: process.cwd() }),
);
