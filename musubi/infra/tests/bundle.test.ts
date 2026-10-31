import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const osnApiWrangler = fileURLToPath(new URL("../../../osn/api/wrangler.toml", import.meta.url));

/** Workers Free's limit on a Worker's compressed size: 3 MiB. */
const FREE_LIMIT = 3 * 1024 * 1024;

const textOf = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

/** A Durable Object namespace binding whose class this Worker hosts: no script name. */
const isHostedDurableObject = (binding: unknown): binding is { readonly className: string } =>
  typeof binding === "object" &&
  binding !== null &&
  (binding as { kind?: unknown }).kind === "Cloudflare.DurableObject" &&
  typeof (binding as { className?: unknown }).className === "string" &&
  (binding as { scriptName?: unknown }).scriptName === undefined;

describe("osn-api's bundle", () => {
  test("K10: bundled offline through Alchemy's rolldown path with the stack's build options, its main module exports every Durable Object class it binds, no module names bun:sqlite, and every file gzips to 3 MiB or less in total", async () => {
    const evaluation = await evaluateMusubi({
      stage: "dev",
      env: stackEnv(await generateArcPublicJwk()),
    });
    const props = resourcesOf(evaluation).OsnApi?.Props;
    if (props?.main === undefined) throw new Error("osn-api declares no main");
    const main = props.main;
    // The stack bundles osn-api from the entry its Wrangler config names.
    const wrangler = Bun.TOML.parse(readFileSync(osnApiWrangler, "utf8")) as { main: string };
    expect(resolve(packageDir, main)).toBe(resolve(dirname(osnApiWrangler), wrangler.main));
    expect(props.bundle).toBe(true);

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

    // Cloudflare refuses an upload whose bindings name a class the main
    // module does not export, and Alchemy runs no dry run that would say so.
    const hosted = Object.values(props.env ?? {}).flatMap((binding) =>
      isHostedDurableObject(binding) ? [binding.className] : [],
    );
    expect(hosted).toEqual(["CoordinationStore"]);
    // Alchemy's BundleOutput puts the entry first (alchemy src/Bundle/Bundle.ts).
    const [entry] = bundle.files;
    const exported = new Bun.Transpiler({ loader: "js" }).scan(textOf(entry.content)).exports;
    expect(hosted.filter((className) => !exported.includes(className))).toEqual([]);
    const naming = modules
      .filter((file) => textOf(file.content).includes("bun:sqlite"))
      .map((file) => file.path);
    expect(naming).toEqual([]);

    // Workers Free refuses a Worker over 3 MiB compressed, and Alchemy
    // uploads every file the bundle holds, source maps included.
    const gzipBytes = bundle.files.reduce(
      (sum, file) => sum + gzipSync(file.content).byteLength,
      0,
    );
    expect(gzipBytes, `${gzipBytes} bytes gzip, maps included`).toBeLessThanOrEqual(FREE_LIMIT);
  }, 60_000);
});
