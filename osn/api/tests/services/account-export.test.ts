import { describe, expect, it } from "@effect/vitest";
import { connections, dsarRequests, organisations } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import {
  closeDsarRequest,
  getExportStatus,
  openDsarRequest,
  streamAccountExport,
} from "../../src/services/accountExport";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const drainStream = async (stream: AsyncIterable<{ raw: string }>): Promise<unknown[]> => {
  const lines: unknown[] = [];
  for await (const l of stream) lines.push(JSON.parse(l.raw));
  return lines;
};

describe("streamAccountExport", () => {
  it.effect("emits the canonical NDJSON envelope (header, sections, trailer)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar1@example.com", "dsar1");
      const result = yield* streamAccountExport({
        accountId: profile.accountId,
        skipBridges: true,
      });
      const lines = (yield* Effect.promise(() => drainStream(result.stream))) as Array<
        Record<string, unknown>
      >;
      // Header is always first.
      expect(lines[0]).toMatchObject({ version: 1 });
      expect(Array.isArray((lines[0] as { sections: unknown }).sections)).toBe(true);
      // Trailer is always last.
      const last = lines[lines.length - 1] as Record<string, unknown>;
      expect(last.end).toBe(true);
      expect(typeof last.completedAt).toBe("string");
      // Decision is fulfilled when no bridge degraded.
      expect(result.decision()).toBe("fulfilled");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("never includes accountId, credentialId, publicKey, or session id", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar2@example.com", "dsar2");
      const result = yield* streamAccountExport({
        accountId: profile.accountId,
        skipBridges: true,
      });
      const lines = (yield* Effect.promise(() => drainStream(result.stream))) as Array<
        Record<string, unknown>
      >;
      const text = lines.map((l) => JSON.stringify(l)).join("\n");
      // Privacy invariant — none of these fields are exported on any line.
      expect(text).not.toContain("account_id");
      expect(text).not.toContain("credential_id");
      expect(text).not.toContain("public_key");
      // sessions.id (token hash) is also excluded; its column is `id`
      // inside `sessions`, but exported sessions only carry ua_label /
      // ip_hash / family_id / timestamps.
      const sessionRow = lines.find((l) => (l as { section?: string }).section === "sessions");
      expect(sessionRow).toBeUndefined(); // no sessions in this test
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("includes connections in both directions, deduped", () =>
    Effect.gen(function* () {
      const me = yield* auth.registerProfile("dsar3@example.com", "dsar3");
      const them = yield* auth.registerProfile("dsar4@example.com", "dsar4");

      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(connections).values({
          id: "conn_a",
          requesterId: me.id,
          addresseeId: them.id,
          status: "accepted",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      yield* Effect.promise(() =>
        db.insert(connections).values({
          id: "conn_b",
          requesterId: them.id,
          addresseeId: me.id,
          status: "accepted",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      const result = yield* streamAccountExport({
        accountId: me.accountId,
        skipBridges: true,
      });
      const lines = (yield* Effect.promise(() => drainStream(result.stream))) as Array<
        Record<string, unknown>
      >;
      const connRows = lines.filter((l) => (l as { section?: string }).section === "connections");
      // Both rows should be present (one outgoing, one incoming).
      expect(connRows).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("includes organisations the user owns", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar5@example.com", "dsar5");
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(organisations).values({
          id: "org_a",
          handle: "acme",
          name: "Acme Corp",
          ownerId: profile.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const result = yield* streamAccountExport({
        accountId: profile.accountId,
        skipBridges: true,
      });
      const lines = (yield* Effect.promise(() => drainStream(result.stream))) as Array<
        Record<string, unknown>
      >;
      const orgRow = lines.find(
        (l) =>
          (l as { section?: string }).section === "organisations" &&
          (l as { row?: { handle?: string } }).row?.handle === "acme",
      );
      expect(orgRow).toBeDefined();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("dsar_requests audit row", () => {
  it.effect("openDsarRequest inserts a row with closedAt=null", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar6@example.com", "dsar6");
      const { id } = yield* openDsarRequest(profile.accountId, "access");
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() => db.select().from(dsarRequests));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(id);
      expect(rows[0]?.closedAt).toBeNull();
      expect(rows[0]?.decision).toBeNull();
      expect(rows[0]?.regime).toBe("both");
      expect(rows[0]?.right).toBe("access");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("closeDsarRequest sets closedAt and decision", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar7@example.com", "dsar7");
      const { id } = yield* openDsarRequest(profile.accountId, "access");
      yield* closeDsarRequest(id, "fulfilled");
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() => db.select().from(dsarRequests));
      expect(rows[0]?.closedAt).not.toBeNull();
      expect(rows[0]?.decision).toBe("fulfilled");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("getExportStatus", () => {
  it.effect("returns null/null when no DSARs have been opened", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar8@example.com", "dsar8");
      const status = yield* getExportStatus(profile.accountId);
      expect(status.lastExportAt).toBeNull();
      expect(status.nextAvailableAt).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns lastExportAt + nextAvailableAt within the cooldown window", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("dsar9@example.com", "dsar9");
      yield* openDsarRequest(profile.accountId, "access");
      const status = yield* getExportStatus(profile.accountId, 86_400_000);
      expect(status.lastExportAt).not.toBeNull();
      expect(status.nextAvailableAt).not.toBeNull();
      const next = new Date(status.nextAvailableAt!).getTime();
      expect(next).toBeGreaterThan(Date.now());
      expect(next - Date.now()).toBeLessThanOrEqual(86_400_000 + 5_000);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
