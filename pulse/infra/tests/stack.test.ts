import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { DEV_DOMAIN, evaluatePulse, resourcesOf, stackEnv, type Evaluation } from "./evaluate";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluatePulse({ stage: "dev", env: stackEnv() });
});

describe("the pulse stack, evaluated offline", () => {
  test("K1: pulse landing takes its dev name and its host under DEV_DOMAIN, serving /api/* from its entry module and the rest from its built assets", async () => {
    const resources = resourcesOf(dev);
    expect(dev.fetches).toEqual([]);
    // Logical ids key the state rows, so they never change once deployed.
    expect(Object.keys(resources)).toEqual(["PulseLanding"]);
    const props = resources.PulseLanding?.Props;
    expect({
      name: props?.name,
      domain: props?.domain,
      main: props?.main,
      compatibility: props?.compatibility,
      assets: props?.assets,
      env: props?.env,
    }).toEqual({
      name: "pulse-landing-dev",
      domain: `pulse.${DEV_DOMAIN}`,
      main: "../landing/worker/index.ts",
      compatibility: { date: "2026-08-31", flags: [] },
      // No `redirects`: a built `_redirects` would apply.
      assets: {
        directory: "../landing/dist",
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
        runWorkerFirst: ["/api/*"],
      },
      env: undefined,
    });
    // The stack runs from its own directory, so `main` names pulse landing's Worker entry.
    expect(resolve(packageDir, props?.main ?? "")).toBe(
      resolve(repoRoot, "pulse/landing/worker/index.ts"),
    );

    // An investigation stage derives the name and host from its own name.
    const investigation = resourcesOf(await evaluatePulse({ stage: "probe", env: stackEnv() }));
    expect(investigation.PulseLanding?.Props.name).toBe("pulse-landing-probe");
    expect(investigation.PulseLanding?.Props.domain).toBe(`pulse.probe.${DEV_DOMAIN}`);
  });

  test("K5: pulse landing is retained on destroy and replacement on the dev stage", () => {
    const resources = resourcesOf(dev);
    expect(
      Object.values(resources).map((resource) => [resource.LogicalId, resource.RemovalPolicy]),
    ).toEqual([["PulseLanding", "retain"]]);
  });
});
