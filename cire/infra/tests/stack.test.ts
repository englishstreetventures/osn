import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SiteBuildError } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { refusedTargets } from "../../../shared/infra/tests/support/refused-targets";
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

  test("K4: invocation logs are off on cire-api and cire-invites", () => {
    const resources = resourcesOf(dev);
    for (const logicalId of ["CireApi", "CireInvites"]) {
      expect({ [logicalId]: resources[logicalId]?.Props.observability?.logs }).toEqual({
        [logicalId]: { enabled: true, invocationLogs: false },
      });
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
    const chain = readdirSync(join(repoRoot, "cire/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
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

  test.each(refusedTargets(["cire-api", "cire-invites"]))(
    "K12: $name refuses the run before it writes or calls anything",
    async (target) => {
      const refused = await evaluateCire({
        stage: target.stage,
        env: target.edit(stackEnv()),
        workingDirFiles: target.workingDirFiles,
      });
      expect(failureOf(refused)).toBeInstanceOf(target.refusal);
      expect(failureOf(refused)).toMatchObject(target.fields(refused));
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
