import { Database } from "bun:sqlite";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import { applySchema } from "../src/testing";

function createTestDb() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
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
      createdByProfileId: "usr_alice",
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
      createdByProfileId: "usr_alice",
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
      createdByProfileId: "usr_alice",
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
    expect(row!.priceAmount).toBeNull();
    expect(row!.priceCurrency).toBeNull();
    expect(row!.latitude).toBeNull();
    expect(row!.longitude).toBeNull();
    expect(row!.createdByName).toBeNull();
    expect(row!.createdByAvatar).toBeNull();
  });

  it("round-trips priceAmount + priceCurrency", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_price",
      title: "Paid Event",
      startTime: now,
      priceAmount: 1850,
      priceCurrency: "USD",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_price"));
    expect(row!.priceAmount).toBe(1850);
    expect(row!.priceCurrency).toBe("USD");
  });

  it("visibility/guestListVisibility/joinPolicy/allowInterested/commsChannels default correctly", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_cfg_defaults",
      title: "Defaults",
      startTime: now,
      createdByProfileId: "usr_alice",
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

  it("declares indexes required by discovery", () => {
    const { indexes } = getTableConfig(schema.events);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    // Powers `visibility = ?` + `start_time BETWEEN ?` under a single seek.
    expect(indexNames.has("events_visibility_start_time_idx")).toBe(true);
    // Single-column category filter.
    expect(indexNames.has("events_category_idx")).toBe(true);
    // Bbox range-scan prefilter for radius search.
    expect(indexNames.has("events_lat_lng_idx")).toBe(true);
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
      createdByProfileId: "usr_alice",
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
      createdByProfileId: "usr_alice",
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
      profileId: "usr_alice",
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
    expect(row.profileId).toBe("usr_alice");
    expect(row.status).toBe("going");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("defaults status to 'going'", async () => {
    const db = createTestDb();
    await seedEvent(db);
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_default",
      eventId: "evt_rsvp_test",
      profileId: "usr_bob",
      createdAt: new Date(),
    });

    const [row] = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_default"));
    expect(row!.status).toBe("going");
  });

  it("accepts invited status + invitedByProfileId", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_invited",
      eventId: "evt_rsvp_test",
      profileId: "usr_bob",
      status: "invited",
      invitedByProfileId: "usr_alice",
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.eventRsvps)
      .where(eq(schema.eventRsvps.id, "rsvp_invited"));
    expect(row!.status).toBe("invited");
    expect(row!.invitedByProfileId).toBe("usr_alice");
  });

  it("enforces unique (event_id, profile_id) constraint", async () => {
    const db = createTestDb();
    await seedEvent(db);
    const now = new Date();
    await db.insert(schema.eventRsvps).values({
      id: "rsvp_dup1",
      eventId: "evt_rsvp_test",
      profileId: "usr_alice",
      createdAt: now,
    });
    await expect(
      db.insert(schema.eventRsvps).values({
        id: "rsvp_dup2",
        eventId: "evt_rsvp_test",
        profileId: "usr_alice",
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
        createdByProfileId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "evt_b",
        title: "B",
        startTime: now,
        createdByProfileId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.eventRsvps).values([
      { id: "rsvp_a", eventId: "evt_a", profileId: "usr_alice", createdAt: now },
      { id: "rsvp_b", eventId: "evt_b", profileId: "usr_alice", createdAt: now },
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
      profileId: "usr_ts",
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
      profileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.pulseUsers)
      .where(eq(schema.pulseUsers.profileId, "usr_alice"));
    expect(row!.profileId).toBe("usr_alice");
    expect(row!.attendanceVisibility).toBe("connections");
  });

  it("accepts connections and no_one values", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseUsers).values([
      {
        profileId: "usr_conn",
        attendanceVisibility: "connections",
        createdAt: now,
        updatedAt: now,
      },
      { profileId: "usr_none", attendanceVisibility: "no_one", createdAt: now, updatedAt: now },
    ]);
    const rows = await db.select().from(schema.pulseUsers);
    expect(rows.map((r) => r.attendanceVisibility).toSorted()).toEqual(["connections", "no_one"]);
  });
});

// ---------------------------------------------------------------------------
// event_comms schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pulse_close_friends schema
// ---------------------------------------------------------------------------

describe("pulse_close_friends schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseCloseFriends).values({
      id: "pcf_1",
      profileId: "usr_alice",
      friendId: "usr_bob",
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.pulseCloseFriends)
      .where(eq(schema.pulseCloseFriends.id, "pcf_1"));
    expect(row!.profileId).toBe("usr_alice");
    expect(row!.friendId).toBe("usr_bob");
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique (profile_id, friend_id) pair", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseCloseFriends).values({
      id: "pcf_dup1",
      profileId: "usr_alice",
      friendId: "usr_bob",
      createdAt: now,
    });
    await expect(
      db.insert(schema.pulseCloseFriends).values({
        id: "pcf_dup2",
        profileId: "usr_alice",
        friendId: "usr_bob",
        createdAt: now,
      }),
    ).rejects.toThrow();
  });

  it("allows the same friend across two different profiles (one-way edges)", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.pulseCloseFriends).values([
      { id: "pcf_a", profileId: "usr_alice", friendId: "usr_carol", createdAt: now },
      { id: "pcf_b", profileId: "usr_bob", friendId: "usr_carol", createdAt: now },
    ]);
    const rows = await db
      .select()
      .from(schema.pulseCloseFriends)
      .where(eq(schema.pulseCloseFriends.friendId, "usr_carol"));
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// venues schema
// ---------------------------------------------------------------------------

describe("venues schema", () => {
  it("inserts and retrieves a venue with defaults", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.venues).values({
      id: "the-pickle-factory",
      orgHandle: "tpf-collective",
      handle: "the-pickle-factory",
      name: "The Pickle Factory",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.venues)
      .where(eq(schema.venues.id, "the-pickle-factory"));
    expect(row!.name).toBe("The Pickle Factory");
    expect(row!.kind).toBe("club");
    expect(row!.timezone).toBe("UTC");
    expect(row!.address).toBeNull();
    expect(row!.capacity).toBeNull();
  });

  it("round-trips JSON hours", async () => {
    const db = createTestDb();
    const now = new Date();
    const hours = JSON.stringify({ "5": { open: "22:00", close: "04:00" } });
    await db.insert(schema.venues).values({
      id: "v-hours",
      orgHandle: "o1",
      handle: "v-hours",
      name: "V",
      hours,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(schema.venues).where(eq(schema.venues.id, "v-hours"));
    expect(row!.hours).toBe(hours);
  });

  it("declares the bbox + kind indexes", () => {
    const { indexes } = getTableConfig(schema.venues);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    expect(indexNames.has("venues_kind_idx")).toBe(true);
    expect(indexNames.has("venues_lat_lng_idx")).toBe(true);
    expect(indexNames.has("venues_org_handle_idx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// events.venueId FK
// ---------------------------------------------------------------------------

describe("events.venueId", () => {
  it("links an event to a venue", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.venues).values({
      id: "v-link",
      orgHandle: "o1",
      handle: "v-link",
      name: "Linked Venue",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.events).values({
      id: "evt_linked",
      title: "Linked",
      startTime: now,
      venueId: "v-link",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_linked"));
    expect(row!.venueId).toBe("v-link");
  });

  it("declares the events_venue_id_idx", () => {
    const { indexes } = getTableConfig(schema.events);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    expect(indexNames.has("events_venue_id_idx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// event_lineup schema
// ---------------------------------------------------------------------------

describe("event_lineup schema", () => {
  async function seedClubNight(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.venues).values({
      id: "v-club",
      orgHandle: "o1",
      handle: "v-club",
      name: "Club",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.events).values({
      id: "evt_night",
      title: "Friday Night",
      startTime: new Date("2030-06-07T21:00:00.000Z"),
      venueId: "v-club",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("inserts and retrieves a lineup slot with defaults", async () => {
    const db = createTestDb();
    await seedClubNight(db);
    const start = new Date("2030-06-07T22:00:00.000Z");
    const end = new Date("2030-06-07T23:30:00.000Z");
    await db.insert(schema.eventLineup).values({
      id: "lnp_1",
      eventId: "evt_night",
      artistName: "Headliner X",
      slotStart: start,
      slotEnd: end,
      createdAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.eventLineup)
      .where(eq(schema.eventLineup.id, "lnp_1"));
    expect(row!.eventId).toBe("evt_night");
    expect(row!.artistName).toBe("Headliner X");
    expect(row!.role).toBe("support");
    expect(row!.orderIndex).toBe(0);
    expect(row!.slotStart).toBeInstanceOf(Date);
    expect(row!.slotStart.getTime()).toBe(start.getTime());
  });

  it("accepts a midnight-crossing slot (slotEnd > slotStart on the next day)", async () => {
    const db = createTestDb();
    await seedClubNight(db);
    const start = new Date("2030-06-07T23:30:00.000Z");
    const end = new Date("2030-06-08T01:00:00.000Z");
    await db.insert(schema.eventLineup).values({
      id: "lnp_xmid",
      eventId: "evt_night",
      artistName: "Closer",
      role: "headliner",
      slotStart: start,
      slotEnd: end,
      orderIndex: 3,
      createdAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.eventLineup)
      .where(eq(schema.eventLineup.id, "lnp_xmid"));
    expect(row!.slotEnd.getTime()).toBeGreaterThan(row!.slotStart.getTime());
    expect(row!.role).toBe("headliner");
  });

  it("declares the event_id+slot_start lookup index", () => {
    const { indexes } = getTableConfig(schema.eventLineup);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    expect(indexNames.has("event_lineup_event_id_idx")).toBe(true);
  });
});

describe("event_comms schema", () => {
  async function seedEvent(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_comms",
      title: "Comms Event",
      startTime: now,
      createdByProfileId: "usr_alice",
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
      sentByProfileId: "usr_alice",
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
      sentByProfileId: "usr_alice",
      createdAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.eventComms)
      .where(eq(schema.eventComms.id, "evtcomm_queued"));
    expect(row!.sentAt).toBeNull();
  });
});
