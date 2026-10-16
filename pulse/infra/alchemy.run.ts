import {
  assertDevDeployTarget,
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
 * writes no file; every value is checked before anything is declared.
 * Paths are relative to the working directory, `pulse/infra`.
 */
export const pulseStack = (input: { readonly env: Readonly<Record<string, string | undefined>> }) =>
  Effect.gen(function* () {
    const { env } = input;
    refuseDotEnvFiles(process.cwd());
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
    const declared = pulseDeclaration({ stage, hosts });

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const landing = yield* siteWorker("PulseLanding", declared.pulseLanding);
    assertStackRetained({ stage, storage: [], workers: [landing] });
    return { pulseLanding: hosts.pulseLanding };
  });

export default Alchemy.Stack("pulse", stackOptions(), pulseStack({ env: process.env }));
