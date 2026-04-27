import { eventRsvps, pulseUsers } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAccountExportInternalRoutes } from "../../src/routes/accountExportInternal";
import { createTestLayer, seedEvent } from "../helpers/db";

/**
 * HTTP-level coverage for the Pulse internal export endpoint
 * (`POST /account-export/internal`). Verifies the wire contract the
 * `osn/api` orchestrator's bridge depends on — header banner first,
 * `{section,row}` lines, `{end:true}` trailer last — plus auth gating.
 */

const ENV_KEY = "INTERNAL_SERVICE_SECRET";
const SECRET = "test-internal-secret-pulse";

let restore: string | undefined;
beforeEach(() => {
  restore = process.env[ENV_KEY];
  process.env[ENV_KEY] = SECRET;
});
afterEach(() => {
  if (restore === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = restore;
});

const parseNdjson = async (res: Response): Promise<Array<Record<string, unknown>>> => {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("POST /account-export/internal (pulse)", () => {
  it("returns 401 when the bearer secret is wrong", async () => {
    const app = createAccountExportInternalRoutes(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 501 when INTERNAL_SERVICE_SECRET is unset (fail-loud)", async () => {
    delete process.env[ENV_KEY];
    const app = createAccountExportInternalRoutes(createTestLayer());
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    expect(res.status).toBe(501);
  });

  it("rejects the body when more than 50 profile IDs are supplied", async () => {
    const app = createAccountExportInternalRoutes(createTestLayer());
    const tooMany = Array.from({ length: 51 }, (_, i) => `usr_${i}`);
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: tooMany }),
      }),
    );
    // Elysia TypeBox `maxItems` validation kicks in before the handler.
    expect(res.status).toBe(422);
  });

  it("streams a valid NDJSON envelope: source banner first, end trailer last", async () => {
    const layer = createTestLayer();
    const app = createAccountExportInternalRoutes(layer);
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const lines = await parseNdjson(res);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatchObject({ source: "pulse-api", profileCount: 0 });
    expect(lines[lines.length - 1]).toMatchObject({ end: true });
  });

  it("emits per-section rows for the supplied profile IDs", async () => {
    const layer = createTestLayer();
    const profileId = "usr_alice";

    // Seed a hosted event + an RSVP + a settings row.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedEvent({
          title: "Alice's Event",
          startTime: new Date(Date.now() + 86_400_000).toISOString(),
          createdByProfileId: profileId,
        });
        const other = yield* seedEvent({
          title: "Other",
          startTime: new Date(Date.now() + 172_800_000).toISOString(),
          createdByProfileId: "usr_bob",
        });
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db.insert(eventRsvps).values({
            id: "rsvp_a",
            eventId: other.id,
            profileId,
            status: "going",
            invitedByProfileId: null,
            createdAt: new Date(),
          }),
        );
        yield* Effect.promise(() =>
          db.insert(pulseUsers).values({
            profileId,
            attendanceVisibility: "no_one",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    const app = createAccountExportInternalRoutes(layer);
    const res = await app.handle(
      new Request("http://localhost/account-export/internal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileIds: [profileId] }),
      }),
    );
    const lines = await parseNdjson(res);
    const sections = new Set(
      lines.filter((l) => "section" in l).map((l) => (l as { section: string }).section),
    );
    expect(sections.has("pulse.rsvps")).toBe(true);
    expect(sections.has("pulse.events_hosted")).toBe(true);
    expect(sections.has("pulse.pulse_users")).toBe(true);
  });
});
