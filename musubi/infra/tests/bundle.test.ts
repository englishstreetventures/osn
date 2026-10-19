import * as BunServices from "@effect/platform-bun/BunServices";
import { getCompatibility } from "alchemy/Cloudflare/Workers/Compatibility";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import { Effect } from "effect";
import { afterAll, describe, expect, test } from "vitest";

import {
  evaluateMusubi,
  generateArcPublicJwk,
  removeEvaluations,
  resourcesOf,
  stackEnv,
} from "./evaluate";

afterAll(removeEvaluations);

describe("osn-api's bundle", () => {
  test("K10: bundled offline through Alchemy's rolldown path with the stack's build options, no module names bun:sqlite", async () => {
    const evaluation = await evaluateMusubi({
      stage: "dev",
      env: stackEnv(await generateArcPublicJwk()),
    });
    const props = resourcesOf(evaluation).OsnApi?.Props;
    if (props?.main === undefined) throw new Error("osn-api declares no main");
    const main = props.main;

    // What the Worker provider does for a bundled Worker declared by props
    // alone (alchemy src/Cloudflare/Workers/WorkerProvider.ts, prepareBundle).
    const bundle = await Effect.runPromise(
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build({
          id: "OsnApi",
          main,
          compatibility: getCompatibility({ ...props, isExternal: true }),
          entry: { kind: "external" },
          stack: { name: "musubi", stage: "dev" },
          extraOptions: props.build,
        });
      }).pipe(Effect.provide(BunServices.layer)),
    );

    const modules = bundle.files.filter((file) => !file.path.endsWith(".map"));
    expect(modules.length).toBeGreaterThan(0);
    const naming = modules
      .filter((file) =>
        (typeof file.content === "string"
          ? file.content
          : new TextDecoder().decode(file.content)
        ).includes("bun:sqlite"),
      )
      .map((file) => file.path);
    expect(naming).toEqual([]);
  });
});
