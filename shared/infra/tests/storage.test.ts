import { describe, expect, test } from "vitest";

import { ProductionNotAdoptedError } from "../src/production";
import {
  AdoptedLocationHintError,
  ProductionSeedError,
  retainedBucketProps,
  retainedD1Props,
  type RetainedBucketInput,
} from "../src/storage";

describe("retainedD1Props", () => {
  const cireDb = {
    name: "cire-db",
    stage: "production",
    readReplication: "disabled",
    jurisdiction: "default",
    locationHint: null,
    importFiles: [],
  } as const;

  const MIGRATIONS = ".generated/migrations/cire-db";

  test("declares only what adoption converges on production, its migrations, and no creation-only setting", () => {
    expect(retainedD1Props({ ...cireDb, migrations: MIGRATIONS }, ["cire-db"])).toEqual({
      name: "cire-db",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
      migrations: { dir: MIGRATIONS, table: "__alchemy_migrations" },
    });
  });

  test("refuses a location hint on production, where the database is adopted", () => {
    expect(() =>
      retainedD1Props({ ...cireDb, locationHint: "oc", migrations: MIGRATIONS }),
    ).toThrow(AdoptedLocationHintError);
  });

  test("places a database a dev stage creates", () => {
    expect(
      retainedD1Props({
        ...cireDb,
        name: "cire-db-dev",
        stage: "dev",
        locationHint: "oc",
        migrations: "../../cire/db/migrations",
      }),
    ).toEqual({
      name: "cire-db-dev",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
      primaryLocationHint: "oc",
      migrations: { dir: "../../cire/db/migrations", table: "__alchemy_migrations" },
    });
  });

  // An explicit table beats one a prior deploy stamped into state
  // (`@alchemy.run/sql` Registry.ts `resolveMigrations`), so Alchemy never
  // takes a stamped `d1_migrations` as its own and rebuilds it in place.
  test("names Alchemy's own ledger table, whatever state says", () => {
    expect(retainedD1Props({ ...cireDb, migrations: MIGRATIONS }, ["cire-db"]).migrations).toEqual({
      dir: MIGRATIONS,
      table: "__alchemy_migrations",
    });
  });

  test("B5: seed files reach a dev database's props, and production refuses any", () => {
    const seeds = ["../../cire/db/seed/dev-seed.sql", ".generated/seeds/owner-seat.sql"];
    const props = retainedD1Props({
      ...cireDb,
      name: "cire-db-dev",
      stage: "dev",
      locationHint: "oc",
      migrations: ".generated/migrations/cire-db",
      importFiles: seeds,
    });
    expect(props.importFiles).toEqual(seeds);
    expect(props.importFiles).not.toBe(seeds);
    expect(() =>
      retainedD1Props({ ...cireDb, migrations: MIGRATIONS, importFiles: ["seed.sql"] }),
    ).toThrow(ProductionSeedError);
  });
});

describe("retainedBucketProps", () => {
  // The rule `wrangler r2 bucket lifecycle list cire-assets` printed on 2026-10-15; 7 days in seconds.
  const multipartAbort = {
    id: "Default Multipart Abort Rule",
    enabled: true,
    prefix: "",
    abortMultipartUploadsTransition: { condition: { type: "Age" as const, maxAge: 604800 } },
  };

  test("states every setting Alchemy would otherwise clear, and never empties the bucket", () => {
    expect(
      retainedBucketProps(
        {
          name: "cire-assets",
          stage: "production",
          storageClass: "Standard",
          jurisdiction: "default",
          locationHint: null,
          publicAccess: false,
          lifecycleRules: [multipartAbort],
          cors: [],
          domains: [],
        },
        ["cire-assets"],
      ),
    ).toEqual({
      name: "cire-assets",
      storageClass: "Standard",
      jurisdiction: "default",
      publicAccess: false,
      lifecycleRules: [multipartAbort],
      cors: [],
      domains: [],
      forceDestroy: false,
    });
  });

  const cireSheets: RetainedBucketInput = {
    name: "cire-sheets",
    stage: "production",
    storageClass: "Standard",
    jurisdiction: "default",
    locationHint: null,
    publicAccess: false,
    lifecycleRules: [multipartAbort],
    cors: [],
    domains: [],
  };

  test("leaves object locks unmanaged and sets no location hint on production", () => {
    const props = retainedBucketProps(cireSheets, ["cire-sheets"]);
    expect(props).not.toHaveProperty("locks");
    expect(props).not.toHaveProperty("locationHint");
    expect(() => retainedBucketProps({ ...cireSheets, locationHint: "oc" })).toThrow(
      AdoptedLocationHintError,
    );
  });

  test("places a bucket a dev stage creates", () => {
    expect(
      retainedBucketProps({
        ...cireSheets,
        name: "cire-sheets-dev",
        stage: "dev",
        locationHint: "oc",
      }),
    ).toMatchObject({
      name: "cire-sheets-dev",
      locationHint: "oc",
      lifecycleRules: [multipartAbort],
    });
  });
});

describe("production storage", () => {
  test("BA2: a production database is refused until a step adopts it by name", () => {
    const cireDb = {
      name: "cire-db",
      stage: "production",
      readReplication: "auto",
      jurisdiction: "default",
      locationHint: null,
      migrations: ".generated/migrations/cire-db",
      importFiles: [],
    } as const;
    expect(() => retainedD1Props(cireDb, [])).toThrow(ProductionNotAdoptedError);
    expect(() => retainedD1Props({ ...cireDb, name: "cire-db-new" })).toThrow(
      ProductionNotAdoptedError,
    );
    expect(() => retainedD1Props(cireDb, ["cire-db-dev"])).toThrow(ProductionNotAdoptedError);
    expect(retainedD1Props(cireDb, ["cire-db"]).name).toBe("cire-db");
    expect(retainedD1Props({ ...cireDb, name: "cire-db-dev", stage: "dev" }).name).toBe(
      "cire-db-dev",
    );
  });

  test("BA3: a production bucket is refused until a step adopts it by name", () => {
    const cireAssets: RetainedBucketInput = {
      name: "cire-assets",
      stage: "production",
      storageClass: "Standard",
      jurisdiction: "default",
      locationHint: null,
      publicAccess: false,
      lifecycleRules: [],
      cors: [],
      domains: [],
    };
    expect(() => retainedBucketProps(cireAssets, [])).toThrow(ProductionNotAdoptedError);
    expect(() => retainedBucketProps({ ...cireAssets, name: "cire-assets-new" })).toThrow(
      ProductionNotAdoptedError,
    );
    expect(retainedBucketProps(cireAssets, ["cire-assets"]).name).toBe("cire-assets");
  });
});
