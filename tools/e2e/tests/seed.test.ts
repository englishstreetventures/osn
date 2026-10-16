import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PULSE_OIDC } from "../src/config";
import { seedOsn, seedPulse } from "../src/seed";

const dir = mkdtempSync(join(tmpdir(), "e2e-seed-"));

describe("seedOsn", () => {
  test("registers Pulse as a first-party client with the exact callback and hashed secret", () => {
    const path = join(dir, "osn.db");
    seedOsn(path);
    const db = new Database(path, { readonly: true });
    const row = db
      .query(
        "SELECT client_id, redirect_uris, client_secret_hash, is_first_party, sector_identifier FROM oauth_clients",
      )
      .get() as Record<string, unknown>;
    db.close();
    expect(row).toEqual({
      client_id: PULSE_OIDC.clientId,
      redirect_uris: JSON.stringify([PULSE_OIDC.redirectUri]),
      client_secret_hash: createHash("sha256").update(PULSE_OIDC.secret).digest("hex"),
      is_first_party: 1,
      sector_identifier: "localhost:3001",
    });
  });

  test("refuses a database file that already exists", () => {
    const path = join(dir, "osn-twice.db");
    seedOsn(path);
    expect(() => seedOsn(path)).toThrow(/already exists/);
  });
});

describe("seedPulse", () => {
  test("builds the schema the flows read, with no rows", () => {
    const path = join(dir, "pulse.db");
    seedPulse(path);
    const db = new Database(path, { readonly: true });
    const events = db.query("SELECT count(*) AS n FROM events").get() as { n: number };
    const rsvps = db.query("SELECT count(*) AS n FROM event_rsvps").get() as { n: number };
    db.close();
    expect([events.n, rsvps.n]).toEqual([0, 0]);
  });

  test("refuses a database file that already exists", () => {
    const path = join(dir, "pulse-twice.db");
    seedPulse(path);
    expect(() => seedPulse(path)).toThrow(/already exists/);
  });
});
