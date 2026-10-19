import { Stack } from "alchemy";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { apiWorker, retainedBucket, retainedD1, siteWorker } from "../src/declare";
import { assertRetained, UnretainedResourceError } from "../src/removal";
import { tierSecrets } from "../src/secrets/inventory";
import { tierOf } from "../src/stage";

const bareStack = (stage: string) => ({
  name: "test",
  stage,
  resources: {},
  bindings: {},
  actions: {},
});

/**
 * Runs `declare` on a bare stack. A declaration's type asks for the provider
 * collection, which only plan and deploy read; registration reads the Stack
 * alone, and a service it lacked would fail the run rather than pass it.
 */
const onBareStack = <A, E>(stage: string, declare: Effect.Effect<A, E, unknown>): Promise<A> =>
  Effect.runPromise(
    (declare as Effect.Effect<A, E, Stack>).pipe(Effect.provideService(Stack, bareStack(stage))),
  );

/**
 * The two fields of a registered resource that the engine and
 * `assertRetained` act on. Plain fields come back because a resource is a
 * proxy that `await` would treat as a thenable.
 */
const declared = (
  stage: string,
  declare: Effect.Effect<
    { readonly LogicalId: string; readonly RemovalPolicy: string },
    never,
    unknown
  >,
) =>
  onBareStack(
    stage,
    declare.pipe(Effect.map(({ LogicalId, RemovalPolicy }) => ({ LogicalId, RemovalPolicy }))),
  );

const api = (stage: string) =>
  apiWorker("CireApi", {
    worker: "cire-api",
    name: `cire-api-${stage}`,
    stage,
    main: "../../cire/api/src/index.ts",
    compatibility: { date: "2025-03-01", flags: ["nodejs_compat"] },
    domain: null,
    crons: [],
    workersDev: false,
    vars: {},
    bindings: {},
    secrets: Object.fromEntries(
      tierSecrets("cire-api", tierOf(stage)).secrets.map((name) => [
        name,
        Redacted.make("not-a-real-secret"),
      ]),
    ),
    observability: {
      headSamplingRate: 1,
      redactQueryString: true,
      traces: { enabled: false },
      issues: true,
    },
  });

const site = (stage: string) =>
  siteWorker("CireLanding", {
    name: `cire-landing-${stage}`,
    stage,
    directory: "../../cire/landing/dist",
    domain: null,
    workersDev: false,
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "404-page",
    issues: true,
  });

const database = (stage: string) =>
  retainedD1("CireDb", {
    name: `cire-db-${stage}`,
    stage,
    readReplication: "disabled",
    jurisdiction: "default",
    locationHint: "oc",
    migrations: null,
  });

const bucket = (stage: string) =>
  retainedBucket("CireSheets", {
    name: `cire-sheets-${stage}`,
    stage,
    storageClass: "Standard",
    jurisdiction: "default",
    locationHint: "oc",
    publicAccess: false,
    lifecycleRules: [],
    cors: [],
    domains: [],
  });

describe("declared resources", () => {
  test.each(["dev", "production"])("Workers on %s are retained", async (stage) => {
    expect(await declared(stage, api(stage))).toEqual({
      LogicalId: "CireApi",
      RemovalPolicy: "retain",
    });
    expect((await declared(stage, site(stage))).RemovalPolicy).toBe("retain");
  });

  test("Workers on an investigation stage are destroyed with it", async () => {
    expect((await declared("pr-7", api("pr-7"))).RemovalPolicy).toBe("destroy");
    expect((await declared("pr-7", site("pr-7"))).RemovalPolicy).toBe("destroy");
  });

  test("storage is retained on an investigation stage too", async () => {
    expect(await declared("pr-7", database("pr-7"))).toEqual({
      LogicalId: "CireDb",
      RemovalPolicy: "retain",
    });
    expect((await declared("pr-7", bucket("pr-7"))).RemovalPolicy).toBe("retain");
  });

  test("assertRetained accepts what Alchemy builds and names a resource that would be deleted", async () => {
    const check = (stage: string) =>
      onBareStack(
        stage,
        Effect.all([api(stage), database(stage)]).pipe(
          Effect.flatMap((resources) =>
            Effect.try({ try: () => assertRetained(resources), catch: (error) => error }),
          ),
        ),
      );
    await expect(check("dev")).resolves.toBeUndefined();
    await expect(check("pr-7")).rejects.toBeInstanceOf(UnretainedResourceError);
    await expect(check("pr-7")).rejects.toMatchObject({ logicalIds: ["CireApi"] });
  });
});
