import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PREBUILT_MODULE_RULES,
  PrebuiltSourceMapError,
  SiteBuildError,
  stageHosts,
} from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SURFACES, type SurfaceKey } from "../../../scripts/deploy-surfaces";
import { listMigrations } from "../../../scripts/migration-files";
import { devTarget } from "../../../scripts/smoke-check";
import { refusedTargets } from "../../../shared/infra/tests/support/refused-targets";
import { cireDeclaration } from "../src/declaration";
import { ownerSeatSql, SeedInputError } from "../src/seeds";
import {
  DEV_DOMAIN,
  evaluateCire,
  failureOf,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
  type SiteFixtures,
} from "./evaluate";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The bucket cire-api's reconcile alerts name for `label` on dev. Its module
 * is loaded when the test runs, not imported: type-checking cire-api's
 * source needs the Workers types, which this package does not install.
 */
async function reconcileBucketName(label: "sheets" | "assets"): Promise<string> {
  const cireApi = (await import(join(repoRoot, "cire/api/src/lib/reconcile-alert-email.ts"))) as {
    readonly reconcileBucketName: (label: "sheets" | "assets", env: "dev" | "production") => string;
  };
  return cireApi.reconcileBucketName(label, "dev");
}

/** `text` with its block comments and its `//` comments blanked. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");

/**
 * Each dev surface of the cire stack and the logical id of the Worker it
 * deploys: the smoke check's snapshot, compare and rollback act on that
 * surface's dev target.
 */
const SURFACE_WORKERS = [
  ["cire_api", "CireApi"],
  ["cire_invites", "CireInvites"],
  ["cire_host", "CireHost"],
  ["cire_vendor", "CireVendor"],
  ["cire_landing", "CireLanding"],
] as const satisfies readonly (readonly [SurfaceKey, string])[];

/** cire/db's dev seed, as the stack names it from its working directory. */
const DEV_SEED = "../db/seed/dev-seed.sql";

const WORKERS = ["CireApi", "CireInvites", "CireHost", "CireVendor", "CireLanding"];
const STORAGE = ["CireDb", "CireAssets", "CireSheets"];

/**
 * The origins each cire site's dev build bakes in, under `cire/`: found by
 * building each with deploy.yml's dev values for example.test and searching
 * its output. The guest site's client output names cire-api only in its
 * `_headers` CSP; its server output names cire-api, itself and the marketing
 * site. The organiser portal names cire-api, the account app and the guest
 * site; the vendor portal cire-api and the account app; the marketing site
 * itself (SITE) and the organiser portal.
 */
const SITE_ORIGINS = [
  {
    site: "@cire/invites client",
    directory: "invites/dist/client",
    origins: [`https://api.cire.${DEV_DOMAIN}`],
  },
  {
    site: "@cire/invites server",
    directory: "invites/dist/server",
    origins: [
      `https://api.cire.${DEV_DOMAIN}`,
      `https://invite.cire.${DEV_DOMAIN}`,
      `https://cire.${DEV_DOMAIN}`,
    ],
  },
  {
    site: "@cire/host",
    directory: "host/dist",
    origins: [
      `https://api.cire.${DEV_DOMAIN}`,
      `https://musubi.${DEV_DOMAIN}`,
      `https://invite.cire.${DEV_DOMAIN}`,
    ],
  },
  {
    site: "@cire/vendor",
    directory: "vendor/dist",
    origins: [`https://api.cire.${DEV_DOMAIN}`, `https://musubi.${DEV_DOMAIN}`],
  },
  {
    site: "@cire/landing",
    directory: "landing/dist",
    origins: [`https://cire.${DEV_DOMAIN}`, `https://host.cire.${DEV_DOMAIN}`],
  },
] as const;

const fixtures = (
  edit: (entry: (typeof SITE_ORIGINS)[number]) => readonly string[] = (entry) => entry.origins,
): SiteFixtures => Object.fromEntries(SITE_ORIGINS.map((entry) => [entry.directory, edit(entry)]));

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluateCire({ stage: "dev", env: stackEnv() });
});

afterAll(removeEvaluations);

describe("the cire stack, evaluated offline", () => {
  test("K1: each Worker, database and bucket takes today's dev name, and each Worker its host under DEV_DOMAIN", async () => {
    const resources = resourcesOf(dev);
    expect(dev.fetches).toEqual([]);
    // Logical ids key the state rows, so they never change once deployed.
    expect(Object.keys(resources).toSorted()).toEqual([...WORKERS, ...STORAGE].toSorted());
    expect(
      Object.fromEntries(
        Object.entries(resources).map(([logicalId, resource]) => [logicalId, resource.Props.name]),
      ),
    ).toEqual({
      CireApi: "cire-api-dev",
      CireInvites: "cire-invites-dev",
      CireHost: "cire-host-dev",
      CireVendor: "cire-vendor-dev",
      CireLanding: "cire-landing-dev",
      CireDb: "cire-db-dev",
      CireAssets: "cire-assets-dev",
      CireSheets: "cire-sheets-dev",
    });
    expect(
      Object.fromEntries(
        WORKERS.map((logicalId) => [logicalId, resources[logicalId]?.Props.domain]),
      ),
    ).toEqual({
      CireApi: `api.cire.${DEV_DOMAIN}`,
      CireInvites: `invite.cire.${DEV_DOMAIN}`,
      CireHost: `host.cire.${DEV_DOMAIN}`,
      CireVendor: `vendor.cire.${DEV_DOMAIN}`,
      CireLanding: `cire.${DEV_DOMAIN}`,
    });

    const env = resources.CireApi?.Props.env ?? {};
    expect({
      OSN_ENV: env.OSN_ENV,
      WEB_ORIGIN: env.WEB_ORIGIN,
      OSN_JWKS_URL: env.OSN_JWKS_URL,
      OSN_ISSUER_URL: env.OSN_ISSUER_URL,
      OSN_AUDIENCE: env.OSN_AUDIENCE,
      CIRE_API_ORIGIN: env.CIRE_API_ORIGIN,
      CIRE_OIDC_CLIENT_ID: env.CIRE_OIDC_CLIENT_ID,
      GROWTHBOOK_API_HOST: env.GROWTHBOOK_API_HOST,
      CIRE_R2_RECONCILE_DISABLED: env.CIRE_R2_RECONCILE_DISABLED,
      OSN_API_URL: env.OSN_API_URL,
    }).toEqual({
      OSN_ENV: "dev",
      // Guest site, organiser portal, vendor portal: cire-api reads the entries by position.
      WEB_ORIGIN: [
        `https://invite.cire.${DEV_DOMAIN}`,
        `https://host.cire.${DEV_DOMAIN}`,
        `https://vendor.cire.${DEV_DOMAIN}`,
      ].join(","),
      OSN_JWKS_URL: `https://id.musubi.${DEV_DOMAIN}/.well-known/jwks.json`,
      OSN_ISSUER_URL: `https://id.musubi.${DEV_DOMAIN}`,
      OSN_AUDIENCE: "osn-access",
      CIRE_API_ORIGIN: `https://api.cire.${DEV_DOMAIN}`,
      CIRE_OIDC_CLIENT_ID: "cid_cire",
      GROWTHBOOK_API_HOST: "https://cdn.growthbook.io",
      CIRE_R2_RECONCILE_DISABLED: "false",
      OSN_API_URL: `https://id.musubi.${DEV_DOMAIN}`,
    });
    // Each storage binding is the resource this stack declares, so cire-api
    // reaches the dev database and dev buckets and nothing else.
    expect(env.DB).toBe(resources.CireDb);
    expect(env.ASSETS).toBe(resources.CireAssets);
    expect(env.SHEETS).toBe(resources.CireSheets);
    // The buckets cire-api's reconcile alerts name on dev are the ones the stack creates.
    expect({
      sheets: resources.CireSheets?.Props.name,
      assets: resources.CireAssets?.Props.name,
    }).toEqual({
      sheets: await reconcileBucketName("sheets"),
      assets: await reconcileBucketName("assets"),
    });
    expect(resources.CireInvites?.Props.env).toEqual({});

    // An investigation stage derives every name and host from its own name
    // and keeps the dev posture.
    const investigation = resourcesOf(await evaluateCire({ stage: "probe", env: stackEnv() }));
    expect(
      Object.fromEntries(
        Object.entries(investigation).map(([logicalId, resource]) => [
          logicalId,
          resource.Props.name,
        ]),
      ),
    ).toEqual({
      CireApi: "cire-api-probe",
      CireInvites: "cire-invites-probe",
      CireHost: "cire-host-probe",
      CireVendor: "cire-vendor-probe",
      CireLanding: "cire-landing-probe",
      CireDb: "cire-db-probe",
      CireAssets: "cire-assets-probe",
      CireSheets: "cire-sheets-probe",
    });
    expect(investigation.CireApi?.Props.domain).toBe(`api.cire.probe.${DEV_DOMAIN}`);
    expect(investigation.CireApi?.Props.env?.OSN_ENV).toBe("dev");
  });

  test("K11: no Worker serves a workers.dev host or version preview URLs, each a public host outside Access", async () => {
    const investigation = await evaluateCire({ stage: "probe", env: stackEnv() });
    for (const evaluation of [dev, investigation]) {
      const workers = Object.values(resourcesOf(evaluation)).filter(
        (resource) => resource.Type === "Cloudflare.Worker",
      );
      expect(workers.map((worker) => worker.LogicalId).toSorted()).toEqual([...WORKERS].toSorted());
      for (const worker of workers) {
        expect({ [worker.LogicalId]: worker.Props.workersDev }).toEqual({
          [worker.LogicalId]: { enabled: false, previewsEnabled: false },
        });
      }
    }
  });

  test("K13: each dev surface's smoke target names the Worker the stack deploys for it", () => {
    const resources = resourcesOf(dev);
    expect(
      SURFACES.filter((surface) => surface.stack === "cire")
        .map((surface) => surface.key)
        .toSorted(),
    ).toEqual(SURFACE_WORKERS.map(([key]) => key).toSorted());
    expect(SURFACE_WORKERS.map(([key]) => [key, devTarget(key)?.worker])).toEqual(
      SURFACE_WORKERS.map(([key, logicalId]) => [key, resources[logicalId]?.Props.name]),
    );
  });

  test("K14: each site uploads its build: the guest site Astro's server output, staged with its source maps and unbundled, with its client output as assets; the others their output alone", () => {
    const props = resourcesOf(dev).CireInvites?.Props;
    // cire/invites's Astro config sets no output directory or server entry,
    // so Astro's defaults name the files its build writes.
    const config = withoutComments(
      readFileSync(join(repoRoot, "cire/invites/astro.config.mjs"), "utf8"),
    );
    expect(config).toContain("defineConfig(");
    expect(config).not.toMatch(
      /\b(?:outDir|serverEntry)\s*:|\bbuild\s*:\s*\{[^}]*\b(?:client|server)\s*:/,
    );
    const astro = dirname(
      createRequire(join(repoRoot, "cire/invites/package.json")).resolve("astro/package.json"),
    );
    const defaults = readFileSync(join(astro, "dist/core/config/schemas/defaults.js"), "utf8");
    const build = defaults.slice(defaults.indexOf("build: {"));
    const value = (text: string, key: string): string =>
      new RegExp(`\\b${key}: "([^"]+)"`).exec(text)?.[1] ?? `no ${key} in Astro's defaults`;
    const outDir = posix.join("../invites", value(defaults, "outDir"));
    const staged = join(dev.generatedDir, "invites-server");

    // The stack stages what the Astro build writes, and uploads the staged copy.
    const declared = cireDeclaration({
      stage: "dev",
      hosts: stageHosts(DEV_DOMAIN, "dev"),
      generatedDir: dev.generatedDir,
      ownerSeat: false,
    });
    expect(declared.invitesServer).toEqual({
      source: posix.join(outDir, value(build, "server")).replace(/\/$/, ""),
      main: value(build, "serverEntry"),
      target: staged,
    });
    expect(readFileSync(join(staged, value(build, "serverEntry")), "utf8")).toBe(
      "export default {};\n",
    );
    expect({
      main: props?.main,
      bundle: props?.bundle,
      build: props?.build,
      rules: props?.rules,
      assets: props?.assets,
    }).toEqual({
      main: join(staged, value(build, "serverEntry")),
      // A prebuilt Worker takes no bundler options; its rules upload the
      // staged source maps beside its modules.
      bundle: false,
      build: undefined,
      rules: PREBUILT_MODULE_RULES,
      assets: {
        directory: posix.join(outDir, value(build, "client")).replace(/\/$/, ""),
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    });

    // The organiser portal, vendor portal and marketing site are static
    // output with Wrangler's defaults, and a `_redirects` they build applies.
    const resources = resourcesOf(dev);
    for (const [logicalId, directory] of [
      ["CireHost", "../host/dist"],
      ["CireVendor", "../vendor/dist"],
      ["CireLanding", "../landing/dist"],
    ] as const) {
      const site = resources[logicalId]?.Props;
      expect({ [logicalId]: { main: site?.main, assets: site?.assets } }).toEqual({
        [logicalId]: {
          main: undefined,
          assets: { directory, htmlHandling: "auto-trailing-slash", notFoundHandling: "none" },
        },
      });
    }
  });

  test("K4: invocation logs are off on cire-api and cire-invites", () => {
    const resources = resourcesOf(dev);
    for (const logicalId of ["CireApi", "CireInvites"]) {
      expect({ [logicalId]: resources[logicalId]?.Props.observability?.logs }).toEqual({
        [logicalId]: { enabled: true, invocationLogs: false },
      });
    }
  });

  test("RQ2: cire-api and cire-invites redact query strings, since an OIDC code and a guest's claim code arrive in one", () => {
    const resources = resourcesOf(dev);
    for (const logicalId of ["CireApi", "CireInvites"]) {
      expect({
        [logicalId]: resources[logicalId]?.Props.observability?.redactQueryString,
      }).toEqual({ [logicalId]: true });
    }
  });

  test("K5: every resource the dev stage keeps is retained on destroy and replacement", () => {
    const resources = resourcesOf(dev);
    expect(
      Object.values(resources).map((resource) => [resource.LogicalId, resource.RemovalPolicy]),
    ).toEqual(Object.keys(resources).map((logicalId) => [logicalId, "retain"]));
  });

  test("K6: the dev buckets take production's settings; cire-db-dev takes production's read replication in oc, migrated from the flattened chain", () => {
    const resources = resourcesOf(dev);
    // Production's cire-assets and cire-sheets: Standard, default
    // jurisdiction, ENAM, no CORS, no custom domains, r2.dev off, and one
    // rule aborting incomplete multipart uploads after 7 days.
    for (const [logicalId, name] of [
      ["CireAssets", "cire-assets-dev"],
      ["CireSheets", "cire-sheets-dev"],
    ] as const) {
      expect({ [logicalId]: resources[logicalId]?.Props }).toEqual({
        [logicalId]: {
          name,
          storageClass: "Standard",
          jurisdiction: "default",
          locationHint: "enam",
          publicAccess: false,
          lifecycleRules: [
            {
              id: "Default Multipart Abort Rule",
              enabled: true,
              prefix: "",
              abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
            },
          ],
          cors: [],
          domains: [],
          forceDestroy: false,
        },
      });
    }

    const db = resources.CireDb?.Props;
    expect(db?.readReplication).toEqual({ mode: "auto" });
    expect(db?.jurisdiction).toBe("default");
    expect(db?.primaryLocationHint).toBe("oc");
    const migrations = join(dev.generatedDir, "migrations", "cire-db");
    expect(db?.migrations).toBe(migrations);
    const chain = listMigrations(join(repoRoot, "cire/db/migrations")).toSorted();
    expect(readdirSync(migrations).toSorted()).toEqual(chain);
  });

  test("S6: an invalid CIRE_DEV_OWNER_PROFILE_ID refuses the run and writes nothing; unset or empty seeds no owner seat; a valid one seeds it after the dev seed", async () => {
    const ownerSeat = join(dev.generatedDir, "seeds", "cire-owner-seat.sql");
    // Unset, as the evaluation above ran.
    expect(resourcesOf(dev).CireDb?.Props.importFiles).toEqual([DEV_SEED]);
    expect(existsSync(ownerSeat)).toBe(false);

    // An unset GitHub variable reaches the step as an empty string.
    const empty = await evaluateCire({
      stage: "dev",
      env: { ...stackEnv(), CIRE_DEV_OWNER_PROFILE_ID: "" },
    });
    expect(resourcesOf(empty).CireDb?.Props.importFiles).toEqual([DEV_SEED]);
    expect(existsSync(join(empty.generatedDir, "seeds"))).toBe(false);

    for (const value of [
      " ",
      "usr_",
      "profile_abc",
      " usr_abc",
      "usr_abc ",
      "usr_abc'; DELETE FROM weddings; --",
      "usr_abc\nDELETE FROM weddings",
      "usr_abc.def",
    ]) {
      const refused = await evaluateCire({
        stage: "dev",
        env: { ...stackEnv(), CIRE_DEV_OWNER_PROFILE_ID: value },
      });
      const failure = failureOf(refused);
      expect(failure).toBeInstanceOf(SeedInputError);
      expect(failure).toMatchObject({ input: "CIRE_DEV_OWNER_PROFILE_ID" });
      expect(existsSync(refused.generatedDir)).toBe(false);
    }

    const profileId = "usr_Ab3-x_9";
    const seeded = await evaluateCire({
      stage: "dev",
      env: { ...stackEnv(), CIRE_DEV_OWNER_PROFILE_ID: profileId },
    });
    const seat = join(seeded.generatedDir, "seeds", "cire-owner-seat.sql");
    expect(resourcesOf(seeded).CireDb?.Props.importFiles).toEqual([DEV_SEED, seat]);
    expect(readFileSync(seat, "utf8")).toBe(ownerSeatSql(profileId));
  });

  test("ST-j: a guest-site module naming a missing source map refuses the run before it writes or calls anything", async () => {
    const refused = await evaluateCire({
      stage: "dev",
      env: stackEnv(),
      entry: "export default {};\n//# sourceMappingURL=gone.mjs.map\n",
    });
    expect(failureOf(refused)).toBeInstanceOf(PrebuiltSourceMapError);
    expect(failureOf(refused)).toMatchObject({ module: "entry.mjs" });
    expect(existsSync(refused.generatedDir)).toBe(false);
    expect(refused.fetches).toEqual([]);
  });

  test.each(refusedTargets(["cire-api", "cire-invites"]))(
    "K12: $name refuses the run before it writes or calls anything",
    async (target) => {
      const refused = await evaluateCire({
        stage: target.stage,
        env: target.edit(stackEnv()),
        workingDirFiles: target.workingDirFiles,
      });
      expect(failureOf(refused)).toMatchObject({ _tag: target.refusal, ...target.fields(refused) });
      expect(existsSync(refused.generatedDir)).toBe(false);
      expect(refused.fetches).toEqual([]);
    },
  );

  test("SB9: site output holding exactly the origins each dev build bakes in is accepted", async () => {
    const accepted = await evaluateCire({ stage: "dev", env: stackEnv(), sites: fixtures() });
    expect(Object.keys(resourcesOf(accepted)).toSorted()).toEqual(
      [...WORKERS, ...STORAGE].toSorted(),
    );
    expect(accepted.fetches).toEqual([]);
  });

  test("SB9: site output built for other hosts, or none, refuses the run before it writes or calls anything", async () => {
    const otherHosts = fixtures((entry) =>
      entry.origins.map((value) => value.replace(DEV_DOMAIN, "other.test")),
    );
    for (const sites of [otherHosts, {}]) {
      const refused = await evaluateCire({ stage: "dev", env: stackEnv(), sites });
      expect(failureOf(refused)).toBeInstanceOf(SiteBuildError);
      expect(failureOf(refused)).toMatchObject({
        site: "@cire/invites client",
        missing: [`https://api.cire.${DEV_DOMAIN}`],
      });
      expect(existsSync(refused.generatedDir)).toBe(false);
      expect(refused.fetches).toEqual([]);
    }
    // Every origin counts: output lacking any one is refused, naming its site.
    for (const entry of SITE_ORIGINS) {
      for (const lacking of entry.origins) {
        const refused = await evaluateCire({
          stage: "dev",
          env: stackEnv(),
          sites: fixtures((other) =>
            other === entry ? other.origins.filter((value) => value !== lacking) : other.origins,
          ),
        });
        expect(failureOf(refused)).toMatchObject({ site: entry.site, missing: [lacking] });
        expect(existsSync(refused.generatedDir)).toBe(false);
      }
    }
  });
});
