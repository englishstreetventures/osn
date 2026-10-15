import { describe, expect, test } from "bun:test";

import { PROBE } from "../boundary.ts";
import {
  CIRE_BUCKETS,
  CIRE_DATABASE,
  declaredStorage,
  OSN_DATABASE,
  unretainedStorage,
} from "../declarations.ts";
import { storageFindings, type LiveStorage } from "../storage-preflight.ts";

describe("declared storage", () => {
  test("declares exactly the buckets and databases the probe table pins", () => {
    expect(Object.keys(declaredStorage.buckets).toSorted()).toEqual(
      PROBE.cire.buckets.map((bucket) => bucket.name).toSorted(),
    );
    expect(Object.keys(declaredStorage.databases).toSorted()).toEqual(
      [PROBE.cire.database.name, PROBE.osn.database.name].toSorted(),
    );
    expect(CIRE_BUCKETS.map((bucket) => bucket.binding).toSorted()).toEqual(
      PROBE.cire.buckets.map((bucket) => bucket.binding).toSorted(),
    );
  });

  test("the preflight checks the same settings each resource declares", () => {
    for (const bucket of CIRE_BUCKETS) {
      expect(declaredStorage.buckets[bucket.name]).toBe(bucket.settings);
    }
    for (const database of [CIRE_DATABASE, OSN_DATABASE]) {
      expect(declaredStorage.databases[database.name]).toEqual({
        id: database.id,
        ...database.settings,
      });
    }
  });

  test("logical ids, which key Alchemy's state rows, stay as deployed", () => {
    expect(CIRE_BUCKETS.map((bucket) => bucket.logicalId)).toEqual([
      "CireDevSheets",
      "CireDevAssets",
    ]);
    expect([CIRE_DATABASE.logicalId, OSN_DATABASE.logicalId]).toEqual(["CireDevDb", "OsnDevDb"]);
  });

  test("dev storage configured as declared passes the preflight", () => {
    const live: LiveStorage = {
      buckets: Object.fromEntries(
        CIRE_BUCKETS.map((bucket) => [
          bucket.name,
          { storageClass: "Standard", lifecycleRules: [], corsRules: [], publicAccess: false },
        ]),
      ),
      databases: Object.fromEntries(
        [CIRE_DATABASE, OSN_DATABASE].map((database) => [
          database.name,
          { id: database.id, readReplicationMode: "disabled" },
        ]),
      ),
    };
    expect(storageFindings(declaredStorage, live)).toEqual([]);
  });
});

describe("unretainedStorage", () => {
  test("passes retained resources and names every other one", () => {
    expect(
      unretainedStorage([
        { LogicalId: "CireDevDb", RemovalPolicy: "retain" },
        { LogicalId: "CireDevSheets", RemovalPolicy: "retain" },
      ]),
    ).toEqual([]);
    const findings = unretainedStorage([
      { LogicalId: "CireDevDb", RemovalPolicy: "destroy" },
      { LogicalId: "CireDevSheets", RemovalPolicy: "retain" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("CireDevDb");
  });
});
