import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      venue TEXT,
      category TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      status TEXT NOT NULL DEFAULT 'upcoming',
      image_url TEXT,
      latitude REAL,
      longitude REAL,
      visibility TEXT NOT NULL DEFAULT 'public',
      guest_list_visibility TEXT NOT NULL DEFAULT 'public',
      join_policy TEXT NOT NULL DEFAULT 'open',
      allow_interested INTEGER NOT NULL DEFAULT 1,
      comms_channels TEXT NOT NULL DEFAULT '["email"]',
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE event_rsvps (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'going',
      invited_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (event_id, user_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE pulse_users (
      user_id TEXT PRIMARY KEY,
      attendance_visibility TEXT NOT NULL DEFAULT 'connections',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE event_comms (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      channel TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_by_user_id TEXT NOT NULL,
      sent_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("events schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.events).values({
      id: "evt_test",
      title: "Schema Test",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.events).where(eq(schema.events.id, "evt_test"));
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.id).toBe("evt_test");
    expect(row.title).toBe("Schema Test");
    expect(row.status).toBe("upcoming");
    expect(row.description).toBeNull();
    expect(row.startTime).toBeInstanceOf(Date);
    expect(row.startTime.toISOString()).toBe("2030-06-01T10:00:00.000Z");
  });

  it("startTime round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    const ts = new Date("2026-04-01T12:00:00.000Z");
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_ts",
      title: "Timestamp Test",
      startTime: ts,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_ts"));
    expect(row!.startTime).toBeInstanceOf(Date);
    expect(row!.startTime.getTime()).toBe(ts.getTime());
  });

  it("optional fields default to null", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_nulls",
      title: "Null Test",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_nulls"));
    expect(row!.description).toBeNull();
    expect(row!.location).toBeNull();
    expect(row!.venue).toBeNull();
    expect(row!.category).toBeNull();
    expect(row!.endTime).toBeNull();
    expect(row!.imageUrl).toBeNull();
    expect(row!.latitude).toBeNull();
    expect(row!.longitude).toBeNull();
    expect(row!.createdByName).toBeNull();
    expect(row!.createdByAvatar).toBeNull();
  });

  it("visibility/guestListVisibility/joinPolicy/allowInterested/commsChannels default correctly", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_cfg_defaults",
      title: "Defaults",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, "evt_cfg_defaults"));
    expect(row!.visibility).toBe("public");
    expect(row!.guestListVisibility).toBe("public");
    expect(row!.joinPolicy).toBe("open");
    expect(row!.allowInterested).toBe(true);
    expect(row!.commsChannels).toBe('["email"]');
  });

  it("stores non-default event visibility config", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_cfg_custom",
      title: "Private",
      startTime: now,
      visibility: "private",
      guestListVisibility: "connections",
      joinPolicy: "guest_list",
      allowInterested: false,
      commsChannels: '["sms","email"]',
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, "evt_cfg_custom"));
    expect(row!.visibility).toBe("private");
    expect(row!.guestListVisibility).toBe("connections");
    expect(row!.joinPolicy).toBe("guest_list");
    expect(row!.allowInterested).toBe(false);
    expect(row!.commsChannels).toBe('["sms","email"]');
  });
});

// ---------------------------------------------------------------------------
// event_rsvps schema
// ---------------------------------------------------------------------------

describe("event_rsvps schema", () => {
  async function seedEvent(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_rsvp_test",
      title: "RSVP Test Event",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("inserts and retrieves an RSVP", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_test",
      eventId: "evt_rsvp_test",
      userId: "usr_alice",
      status: "going",
      createdAt: now,
    });

    const rows = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventId).toBe("evt_rsvp_test");
    expect(row.userId).toBe("usr_alice");
    expect(row.status).toBe("going");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("defaults status to 'going'", async () => {
    const db = createTestDb();
    await seedEvent(db);
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_default",
      eventId: "evt_rsvp_test",
      userId: "usr_bob",
      createdAt: new Date(),
    });

    const [row] = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_default"));
    expect(row!.status).toBe("going");
  });

  it("accepts invited status + invitedByUserId", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_invited",
      eventId: "evt_rsvp_test",
      userId: "usr_bob",
      status: "invited",
      invitedByUserId: "usr_alice",
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_invited"));
    expect(row!.status).toBe("invited");
    expect(row!.invitedByUserId).toBe("usr_alice");
  });

  it("enforces unique (event_id, user_id) constraint", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_dup1",
      eventId: "evt_rsvp_test",
      userId: "usr_alice",
      createdAt: now,
    });
    await expect(
      db.insert(schema.eventRsvps).values({
        id: "rsvp_dup2",
        eventId: "evt_rsvp_test",
        userId: "usr_alice",
        createdAt: now,
      }),
    ).rejects.toThrow();
  });

  it("allows same user on different events", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values([
      {
        id: "evt_a",
        title: "A",
        startTime: now,
        createdByUserId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "evt_b",
        title: "B",
        startTime: now,
        createdByUserId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.eventRsvps).values([
      { id: "rsvp_a", eventId: "evt_a", userId: "usr_alice", createdAt: now },
      { id: "rsvp_b", eventId: "evt_b", userId: "usr_alice", createdAt: now },
    ]);
    const rows = await db.select().from(schema.eventRsvps);
    expect(rows).toHaveLength(2);
  });

  it("createdAt round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const ts = new Date("2030-01-15T08:00:00.000Z");
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_ts",
      eventId: "evt_rsvp_test",
      userId: "usr_ts",
      createdAt: ts,
    });
    const [row] = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});

// ---------------------------------------------------------------------------
// pulse_users schema
// ---------------------------------------------------------------------------

describe("pulse_users schema", () => {
  it("inserts and retrieves a row with default attendance visibility", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseUsers).values({
      userId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.pulseUsers)
      .where(eq(schema.pulseUsers.userId, "usr_alice"));
    expect(row!.userId).toBe("usr_alice");
    expect(row!.attendanceVisibility).toBe("connections");
  });

  it("accepts connections and no_one values", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseUsers).values([
      {
        userId: "usr_conn",
        attendanceVisibility: "connections",
        createdAt: now,
        updatedAt: now,
      },
      { userId: "usr_none", attendanceVisibility: "no_one", createdAt: now, updatedAt: now },
    ]);
    const rows = await db.select().from(schema.pulseUsers);
    expect(rows.map((r) => r.attendanceVisibility).sort()).toEqual(["connections", "no_one"]);
  });
});

// ---------------------------------------------------------------------------
// event_comms schema
// ---------------------------------------------------------------------------

describe("event_comms schema", () => {
  async function seedEvent(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_comms",
      title: "Comms Event",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("inserts and retrieves a comms log row", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventComms).values({
      id: "evtcomm_1",
      eventId: "evt_comms",
      channel: "sms",
      body: "Hey everyone, see you tonight!",
      sentByUserId: "usr_alice",
      sentAt: now,
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.eventComms)
      .where(eq(schema.eventComms.id, "evtcomm_1"));
    expect(row!.eventId).toBe("evt_comms");
    expect(row!.channel).toBe("sms");
    expect(row!.body).toContain("tonight");
    expect(row!.sentAt).toBeInstanceOf(Date);
  });

  it("allows null sentAt (queued state)", async () => {
    const db = createTestDb();
    await seedEvent(db);
    await db.insert(schema.eventComms).values({
      id: "evtcomm_queued",
      eventId: "evt_comms",
      channel: "email",
      body: "Queued blast",
      sentByUserId: "usr_alice",
      createdAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.eventComms)
      .where(eq(schema.eventComms.id, "evtcomm_queued"));
    expect(row!.sentAt).toBeNull();
  });
});
