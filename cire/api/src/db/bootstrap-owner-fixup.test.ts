import { describe, expect, it } from "bun:test";

import * as schema from "@cire/db";

import { ensureBootstrapOwner } from "../index";
import { BOOTSTRAP_OWNER_SENTINEL, createDb } from "./setup";

// `ensureBootstrapOwner` is the production path: migration 0006 seeds the
// bootstrap wedding with the inert sentinel owner, and on first isolate boot
// the Worker repoints it onto the real BOOTSTRAP_OWNER_PROFILE_ID — `seedDb`
// (with the local dev default) never runs against D1. These exercise it
// directly against bun:sqlite with the sentinel row the migration would have
// produced.
function seedSentinelWedding() {
  const db = createDb();
  const now = new Date();
  db.insert(schema.weddings)
    .values({
      id: schema.BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      ownerOsnProfileId: BOOTSTRAP_OWNER_SENTINEL,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

const ownerOf = (db: ReturnType<typeof createDb>) =>
  db.select().from(schema.weddings).all()[0]!.ownerOsnProfileId;

describe("ensureBootstrapOwner", () => {
  it("repoints the bootstrap wedding off the sentinel onto the real owner in prod", async () => {
    const db = seedSentinelWedding();
    await ensureBootstrapOwner(db, {
      OSN_ENV: "production",
      BOOTSTRAP_OWNER_PROFILE_ID: "usr_realorganiser123",
    });
    expect(ownerOf(db)).toBe("usr_realorganiser123");
  });

  it("is idempotent — a second run does not re-touch a real owner", async () => {
    const db = seedSentinelWedding();
    const env = { OSN_ENV: "production", BOOTSTRAP_OWNER_PROFILE_ID: "usr_realorganiser123" };
    await ensureBootstrapOwner(db, env);
    await ensureBootstrapOwner(db, env);
    expect(ownerOf(db)).toBe("usr_realorganiser123");
  });

  it("THROWS (fails loud) when deployed and BOOTSTRAP_OWNER_PROFILE_ID is unset", async () => {
    const db = seedSentinelWedding();
    await expect(ensureBootstrapOwner(db, { OSN_ENV: "production" })).rejects.toThrow(
      /BOOTSTRAP_OWNER_PROFILE_ID/,
    );
    // Left untouched at the inert sentinel — ownership gate stays fail-closed.
    expect(ownerOf(db)).toBe(BOOTSTRAP_OWNER_SENTINEL);
  });

  it("leaves the sentinel in place locally (never writes the dev default to D1)", async () => {
    const db = seedSentinelWedding();
    await ensureBootstrapOwner(db, { OSN_ENV: "local" });
    expect(ownerOf(db)).toBe(BOOTSTRAP_OWNER_SENTINEL);
  });
});
