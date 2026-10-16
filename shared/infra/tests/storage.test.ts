import { describe, expect, test } from "vitest";

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

  test("declares only what adoption converges on production, and no creation-only setting", () => {
    expect(retainedD1Props({ ...cireDb, migrations: null })).toEqual({
      name: "cire-db",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
    });
  });

  test("refuses a location hint on production, where the database is adopted", () => {
    expect(() => retainedD1Props({ ...cireDb, locationHint: "oc", migrations: null })).toThrow(
      AdoptedLocationHintError,
    );
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
      migrations: "../../cire/db/migrations",
    });
  });

  test("adds migrations only once Alchemy is the database's migrator", () => {
    expect(retainedD1Props({ ...cireDb, migrations: "../../cire/db/migrations" })).toEqual({
      name: "cire-db",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
      migrations: "../../cire/db/migrations",
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
      retainedD1Props({ ...cireDb, migrations: null, importFiles: ["seed.sql"] }),
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
      retainedBucketProps({
        name: "cire-assets",
        stage: "production",
        storageClass: "Standard",
        jurisdiction: "default",
        locationHint: null,
        publicAccess: false,
        lifecycleRules: [multipartAbort],
        cors: [],
        domains: [],
      }),
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
    const props = retainedBucketProps(cireSheets);
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
