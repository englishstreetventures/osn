import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID } from "@cire/db";

import { createDb, seedDb } from "../../src/db/setup";

/**
 * `registry_settings.stripe_account_type` is `express`, `standard` or NULL, held
 * by two triggers: a CHECK added to an existing table would rebuild it. The DDL
 * lockstep test proves the migration and the test DDL declare the same
 * triggers; this proves the triggers refuse.
 */
describe("registry_settings.stripe_account_type", () => {
  const seeded = () => {
    const db = createDb(":memory:");
    seedDb(db);
    const now = Math.floor(Date.now() / 1000);
    return { client: db.$client, now };
  };

  it("refuses an insert of any other value", () => {
    const { client, now } = seeded();
    expect(() =>
      client
        .prepare(
          "INSERT INTO registry_settings (wedding_id, stripe_account_type, created_at, updated_at) VALUES (?, 'custom', ?, ?)",
        )
        .run(BOOTSTRAP_WEDDING_ID, now, now),
    ).toThrow(/stripe account type is not express or standard/);
  });

  it("refuses an update to any other value, and takes the two types and NULL", () => {
    const { client, now } = seeded();
    client
      .prepare(
        "INSERT INTO registry_settings (wedding_id, stripe_account_type, created_at, updated_at) VALUES (?, NULL, ?, ?)",
      )
      .run(BOOTSTRAP_WEDDING_ID, now, now);
    const set = (value: string | null) =>
      client
        .prepare("UPDATE registry_settings SET stripe_account_type = ? WHERE wedding_id = ?")
        .run(value, BOOTSTRAP_WEDDING_ID);
    expect(() => set("custom")).toThrow(/stripe account type is not express or standard/);
    expect(() => set("standard")).not.toThrow();
    expect(() => set("express")).not.toThrow();
    expect(() => set(null)).not.toThrow();
  });
});
