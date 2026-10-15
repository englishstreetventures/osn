import { describe, expect, test } from "bun:test";

import {
  DEV_BUCKET_SETTINGS,
  DEV_DATABASE_SETTINGS,
  storageFindings,
  type DeclaredStorage,
  type LiveBucket,
  type LiveStorage,
} from "../storage-preflight.ts";

const DB_ID = "bf0510eb-6998-4ee3-b5a0-833c646ef855";

const declared: DeclaredStorage = {
  buckets: { "cire-sheets-dev": DEV_BUCKET_SETTINGS },
  databases: { "cire-db-dev": { id: DB_ID, ...DEV_DATABASE_SETTINGS } },
};

// Shaped like the Cloudflare API's lifecycle rule as the distilled client
// decodes it (`BucketsLifecycleGetResponseRulesItem`), for the rule Cloudflare
// puts on a new bucket.
const defaultMultipartRule = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { maxAge: 604800, type: "Age" } },
} as const;

function bucket(overrides: Partial<LiveBucket> = {}): LiveBucket {
  return {
    storageClass: "Standard",
    lifecycleRules: [],
    corsRules: [],
    publicAccess: false,
    ...overrides,
  };
}

function live(
  overrides: { bucket?: LiveBucket | undefined; database?: LiveStorage["databases"][string] } = {},
): LiveStorage {
  return {
    buckets: { "cire-sheets-dev": "bucket" in overrides ? overrides.bucket : bucket() },
    databases: {
      "cire-db-dev":
        "database" in overrides
          ? overrides.database
          : { id: DB_ID, readReplicationMode: "disabled" },
    },
  };
}

describe("storageFindings", () => {
  test("live storage that matches the declaration passes", () => {
    expect(storageFindings(declared, live())).toEqual([]);
  });

  test("a storage class the API leaves out counts as Standard, as the adoption update reads it", () => {
    expect(storageFindings(declared, live({ bucket: bucket({ storageClass: null }) }))).toEqual([]);
  });

  test("a lifecycle rule the declaration lacks is refused", () => {
    const findings = storageFindings(
      declared,
      live({ bucket: bucket({ lifecycleRules: [defaultMultipartRule] }) }),
    ).join("\n");
    expect(findings).toContain("cire-sheets-dev");
    expect(findings).toContain("lifecycle");
    expect(findings).toContain("Default Multipart Abort Rule");
  });

  test("a declared rule matching the live one passes", () => {
    const withRule: DeclaredStorage = {
      ...declared,
      buckets: {
        "cire-sheets-dev": {
          ...DEV_BUCKET_SETTINGS,
          lifecycleRules: [
            {
              id: "Default Multipart Abort Rule",
              abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
            },
          ],
        },
      },
    };
    expect(
      storageFindings(
        withRule,
        live({ bucket: bucket({ lifecycleRules: [defaultMultipartRule] }) }),
      ),
    ).toEqual([]);
  });

  test("a rule equal in meaning but not in shape is refused, because the adoption update would rewrite it", () => {
    const withRule: DeclaredStorage = {
      ...declared,
      buckets: {
        "cire-sheets-dev": {
          ...DEV_BUCKET_SETTINGS,
          lifecycleRules: [
            {
              id: "Default Multipart Abort Rule",
              abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
            },
          ],
        },
      },
    };
    const liveRule = { ...defaultMultipartRule, storageClassTransitions: [] };
    expect(
      storageFindings(withRule, live({ bucket: bucket({ lifecycleRules: [liveRule] }) })).join(
        "\n",
      ),
    ).toContain("lifecycle");
  });

  test("a CORS rule, public r2.dev access or another storage class is refused", () => {
    const cors = storageFindings(
      declared,
      live({
        bucket: bucket({
          corsRules: [{ allowed: { methods: ["GET"], origins: ["https://example.com"] } }],
        }),
      }),
    ).join("\n");
    const publicAccess = storageFindings(
      declared,
      live({ bucket: bucket({ publicAccess: true }) }),
    ).join("\n");
    const infrequent = storageFindings(
      declared,
      live({ bucket: bucket({ storageClass: "InfrequentAccess" }) }),
    ).join("\n");
    expect(cors).toContain("CORS");
    expect(publicAccess).toContain("r2.dev");
    expect(infrequent).toContain("InfrequentAccess");
  });

  test("a missing bucket or database is refused, so the stack never creates one", () => {
    expect(storageFindings(declared, live({ bucket: undefined })).join("\n")).toContain(
      "R2 bucket cire-sheets-dev does not exist",
    );
    expect(storageFindings(declared, live({ database: undefined })).join("\n")).toContain(
      "D1 database cire-db-dev does not exist",
    );
  });

  test("a database with another id or with read replication on is refused", () => {
    const otherId = storageFindings(
      declared,
      live({
        database: { id: "6e835474-e0a7-4db9-8883-3247c3c891cd", readReplicationMode: "disabled" },
      }),
    ).join("\n");
    const replicated = storageFindings(
      declared,
      live({ database: { id: DB_ID, readReplicationMode: "auto" } }),
    ).join("\n");
    expect(otherId).toContain("6e835474-e0a7-4db9-8883-3247c3c891cd");
    expect(replicated).toContain("read replication");
  });

  test("read replication the API leaves out counts as disabled", () => {
    expect(
      storageFindings(declared, live({ database: { id: DB_ID, readReplicationMode: undefined } })),
    ).toEqual([]);
  });
});
