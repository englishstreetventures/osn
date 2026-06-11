import { Effect, Data } from "effect";

import { events, eventRsvps, eventSeries, venues, eventLineup } from "./schema";
import type {
  NewEvent,
  NewEventRsvp,
  NewEventSeries,
  NewVenue,
  NewEventLineupSlot,
} from "./schema";
import { DbLive, Db } from "./service";

/**
 * Seed profile references matching osn-db seed.
 *
 * usr_seed_me is a stable sentinel — the Pulse frontend compares
 * event.createdByProfileId against the real JWT sub at runtime, so
 * events owned by usr_seed_me will only show delete controls when
 * the signed-in profile's ID actually matches.
 */
const U = {
  me: { id: "usr_seed_me", name: "You (seed)" },
  alice: { id: "usr_seed_alice", name: "Alice Chen" },
  bob: { id: "usr_seed_bob", name: "Bob Martinez" },
  charlie: { id: "usr_seed_charlie", name: "Charlie Park" },
  dana: { id: "usr_seed_dana", name: "Dana Rivera" },
  eli: { id: "usr_seed_eli", name: "Eli Nakamura" },
  faye: { id: "usr_seed_faye", name: "Faye Okonkwo" },
  george: { id: "usr_seed_george", name: "George Kim" },
  hana: { id: "usr_seed_hana", name: "Hana Petrov" },
  ivan: { id: "usr_seed_ivan", name: "Ivan Torres" },
  jess: { id: "usr_seed_jess", name: "Jess Albright" },
  kai: { id: "usr_seed_kai", name: "Kai Sørensen" },
  luna: { id: "usr_seed_luna", name: "Luna Vasquez" },
  milo: { id: "usr_seed_milo", name: "Milo Zhang" },
  nina: { id: "usr_seed_nina", name: "Nina Johansson" },
  omar: { id: "usr_seed_omar", name: "Omar Farouk" },
  priya: { id: "usr_seed_priya", name: "Priya Sharma" },
  quinn: { id: "usr_seed_quinn", name: "Quinn O'Brien" },
  rosa: { id: "usr_seed_rosa", name: "Rosa Delgado" },
  sam: { id: "usr_seed_sam", name: "Sam Oduya" },
} as const;

class SeedError extends Data.TaggedError("SeedError")<{ cause: unknown }> {}

// ---------------------------------------------------------------------------
// Seed venues
// ---------------------------------------------------------------------------

/**
 * Seed venues. Opaque `ven_*` ids for FK targets; `(orgHandle, handle)`
 * is what the public URL `/venues/:orgHandle/:venueHandle` resolves on.
 * Both venues sit under the same fictional org so the seed exercises
 * the "one collective, two rooms" case.
 */
export function buildSeedVenues(now: Date): NewVenue[] {
  return [
    {
      id: "ven_pf",
      orgHandle: "tpf-collective",
      handle: "the-pickle-factory",
      name: "The Pickle Factory",
      kind: "club",
      description:
        "A 250-cap basement room in Bushwick known for vinyl-only sets, an unforgiving Funktion-One rig, and a Friday residency that has launched more than a few careers.",
      address: "55 Knickerbocker Ave, Bushwick",
      city: "Brooklyn, NY",
      country: "United States",
      latitude: 40.705,
      longitude: -73.93,
      capacity: 250,
      hours: JSON.stringify({
        // Mon–Wed closed, Thu–Sat 22:00 → 04:00 next day, Sun 22:00 → 03:00.
        "1": null,
        "2": null,
        "3": null,
        "4": { open: "22:00", close: "04:00" },
        "5": { open: "22:00", close: "04:00" },
        "6": { open: "22:00", close: "04:00" },
        "7": { open: "22:00", close: "03:00" },
      }),
      heroImageUrl:
        "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1600&q=80",
      websiteUrl: "https://example.com/the-pickle-factory",
      instagramHandle: "thepicklefactory",
      timezone: "America/New_York",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ven_blueroom",
      orgHandle: "tpf-collective",
      handle: "blue-room",
      name: "Blue Room",
      kind: "bar",
      description:
        "Listening bar serving negronis and Japanese hi-fi. Programming leans ambient, leftfield, and the slower half of the BPM dial.",
      address: "152 Orchard St",
      city: "New York, NY",
      country: "United States",
      latitude: 40.7197,
      longitude: -73.9879,
      capacity: 80,
      hours: JSON.stringify({
        "1": null,
        "2": { open: "18:00", close: "00:00" },
        "3": { open: "18:00", close: "00:00" },
        "4": { open: "18:00", close: "01:00" },
        "5": { open: "18:00", close: "02:00" },
        "6": { open: "18:00", close: "02:00" },
        "7": { open: "16:00", close: "23:00" },
      }),
      heroImageUrl:
        "https://images.unsplash.com/photo-1485872299712-a85ea08c5c4d?auto=format&fit=crop&w=1600&q=80",
      websiteUrl: null,
      instagramHandle: "blueroom.nyc",
      timezone: "America/New_York",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Events programmed at the seed venues. Most rows are pinned to
 * `the-pickle-factory` so the venue page has a populated carousel + a
 * lineup-rich next-night view. Times are deliberately UTC-anchored —
 * the venue's `timezone` field drives display.
 */
export function buildSeedVenueEvents(now: Date): NewEvent[] {
  const ms = now.getTime();
  const dMs = (n: number) => ms + n * 86_400_000;

  /** Builds a 22:00→05:00 club night a `dayOffset` away from now. */
  const clubNight = (
    id: string,
    dayOffset: number,
    title: string,
    extras: Partial<NewEvent> = {},
  ): NewEvent => {
    const start = new Date(dMs(dayOffset));
    start.setUTCHours(3, 0, 0, 0); // 23:00 EDT (NYC, summer) — late-night slot
    const end = new Date(start.getTime() + 7 * 3_600_000);
    return {
      id,
      title,
      description: extras.description ?? null,
      location: "Bushwick, Brooklyn",
      venue: "The Pickle Factory",
      venueId: "ven_pf",
      latitude: 40.705,
      longitude: -73.93,
      category: "nightlife",
      startTime: start,
      endTime: end,
      status: dayOffset < 0 ? "finished" : "upcoming",
      imageUrl:
        extras.imageUrl ??
        "https://images.unsplash.com/photo-1571266028243-e1f15bb2d8a4?auto=format&fit=crop&w=1200&q=80",
      priceAmount: extras.priceAmount ?? 1500,
      priceCurrency: extras.priceCurrency ?? "GBP",
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      chatId: null,
      seriesId: null,
      instanceOverride: false,
      createdByProfileId: U.alice.id,
      createdByName: U.alice.name,
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
  };

  return [
    clubNight("evt_seed_pf_friday", 2, "Friday Residency: Vinyl Only", {
      description: "The flagship Friday — three residents, vinyl only, no opener. Doors 22:00.",
    }),
    clubNight("evt_seed_pf_saturday", 3, "Late Night Disco", {
      description: "Cosmic, italo, and a few left-turns. Headliner from Berlin.",
      priceAmount: 1800,
    }),
    clubNight("evt_seed_pf_thursday", 1, "Thursday Lab", {
      description: "Experimental + ambient first half, beats after midnight.",
      priceAmount: 1000,
    }),
    clubNight("evt_seed_pf_sunday", 4, "Sunday Closer", {
      description: "Slow-burn Sunday — a long set, then a longer one.",
      priceAmount: 1200,
    }),
    clubNight("evt_seed_pf_lastfriday", -7, "Last Friday's Residency", {
      description: "Past event — keeps the carousel honest about history.",
    }),
  ];
}

/**
 * Lineup slots for the seed Pickle Factory events. Each night is a
 * resident → support → headliner → resident progression so the
 * timeline component renders a representative shape.
 */
export function buildSeedLineup(now: Date): NewEventLineupSlot[] {
  const ms = now.getTime();
  const dMs = (n: number) => ms + n * 86_400_000;

  /**
   * Build a four-slot night anchored on `dayOffset`'s 22:00 UTC. Each
   * slot is 90 minutes; the last set runs into the next day.
   */
  const night = (
    eventId: string,
    dayOffset: number,
    artists: { name: string; role: NewEventLineupSlot["role"] }[],
  ): NewEventLineupSlot[] => {
    const base = new Date(dMs(dayOffset));
    base.setUTCHours(3, 0, 0, 0); // 23:00 EDT, matches clubNight start
    return artists.map((a, i) => {
      const start = new Date(base.getTime() + i * 90 * 60_000);
      const end = new Date(start.getTime() + 90 * 60_000);
      return {
        id: `lnp_seed_${eventId}_${i + 1}`,
        eventId,
        artistName: a.name,
        role: a.role,
        slotStart: start,
        slotEnd: end,
        orderIndex: i,
        createdAt: now,
      };
    });
  };

  return [
    ...night("evt_seed_pf_friday", 2, [
      { name: "Mara Reso", role: "resident" },
      { name: "Tomu DJ", role: "support" },
      { name: "Anu", role: "headliner" },
      { name: "Mara Reso b2b Anu", role: "resident" },
    ]),
    ...night("evt_seed_pf_saturday", 3, [
      { name: "House of Selecta", role: "resident" },
      { name: "Nala Sinephro (DJ set)", role: "support" },
      { name: "DJ Python", role: "headliner" },
      { name: "House of Selecta", role: "resident" },
    ]),
    ...night("evt_seed_pf_thursday", 1, [
      { name: "Kiani del Valle", role: "opener" },
      { name: "Pessimist", role: "support" },
      { name: "Loraine James", role: "headliner" },
    ]),
    ...night("evt_seed_pf_sunday", 4, [
      { name: "Beatrice Dillon", role: "headliner" },
      { name: "Beatrice Dillon", role: "headliner" },
    ]),
    ...night("evt_seed_pf_lastfriday", -7, [
      { name: "Mara Reso", role: "resident" },
      { name: "Shanti Celeste", role: "headliner" },
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Seed events
// ---------------------------------------------------------------------------

/**
 * Builds the seed event rows relative to the given `now`.
 * Exported so tests can assert on the data without hitting a real DB.
 */
export function buildSeedEvents(now: Date): NewEvent[] {
  const ms = now.getTime();
  const hMs = (n: number) => ms + n * 3_600_000;
  const dMs = (n: number) => ms + n * 86_400_000;
  const h = (n: number) => new Date(hMs(n));
  const d = (n: number) => new Date(dMs(n));

  const evt = (
    id: string,
    user: (typeof U)[keyof typeof U],
    overrides: Omit<
      NewEvent,
      "id" | "createdByProfileId" | "createdByName" | "createdByAvatar" | "createdAt" | "updatedAt"
    >,
  ): NewEvent => ({
    id,
    createdByProfileId: user.id,
    createdByName: user.name,
    createdByAvatar: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  return [
    // ── Finished ──────────────────────────────────────────────────────────
    evt("evt_seed_finished1", U.alice, {
      title: "Jazz Night at the Cellar",
      description: "An intimate evening of live jazz across three sets.",
      location: "Lower East Side, New York",
      venue: "The Cellar Bar",
      latitude: 40.7195,
      longitude: -73.9875,
      category: "music",
      startTime: d(-3),
      endTime: new Date(dMs(-3) + 3 * 3_600_000),
      status: "finished",
      priceAmount: 1800,
      priceCurrency: "USD",
    }),
    evt("evt_seed_finished2", U.omar, {
      title: "Vintage Vinyl Swap Meet",
      description: "Bring your crates, swap records, and discover hidden gems.",
      location: "Echo Park, Los Angeles",
      venue: "Stories Books & Cafe",
      latitude: 34.0786,
      longitude: -118.2608,
      category: "music",
      startTime: d(-5),
      endTime: new Date(dMs(-5) + 4 * 3_600_000),
      status: "finished",
    }),

    // ── Ongoing ───────────────────────────────────────────────────────────
    evt("evt_seed_ongoing1", U.bob, {
      title: "Farmers Market – Spring Edition",
      description: "Local produce, street food, and live acoustic sets.",
      location: "Brooklyn, New York",
      venue: "Grand Army Plaza",
      latitude: 40.6724,
      longitude: -73.9696,
      category: "food",
      startTime: h(-2),
      endTime: h(4),
      status: "ongoing",
    }),
    evt("evt_seed_ongoing2", U.alice, {
      title: "Open Source Hack Day",
      description: "All-day hacking session. Bring a laptop and a project idea.",
      location: "SOMA, San Francisco",
      venue: "Cloudflare HQ",
      latitude: 37.7786,
      longitude: -122.3908,
      category: "tech",
      startTime: h(-5),
      endTime: h(7),
      status: "ongoing",
    }),
    evt("evt_seed_ongoing3", U.me, {
      title: "Sunset Rooftop Yoga",
      description: "Vinyasa flow with panoramic city views as the sun goes down.",
      location: "Midtown, New York",
      venue: "The High Line Hotel",
      latitude: 40.7473,
      longitude: -74.0027,
      category: "wellness",
      startTime: new Date(ms - 45 * 60_000),
      endTime: new Date(ms + 75 * 60_000),
      status: "ongoing",
    }),
    evt("evt_seed_ongoing4", U.dana, {
      title: "Weekend Pottery Studio",
      description: "Drop-in wheel throwing and hand-building. All skill levels.",
      location: "Bushwick, Brooklyn",
      venue: "Clay Space Studio",
      latitude: 40.6944,
      longitude: -73.9213,
      category: "art",
      startTime: h(-3),
      endTime: h(5),
      status: "ongoing",
    }),

    // ── Upcoming ──────────────────────────────────────────────────────────
    evt("evt_seed_upcoming1", U.me, {
      title: "Bun + Effect.ts Workshop",
      description: "Hands-on workshop covering Bun internals and Effect service patterns.",
      location: "Tech District, San Francisco",
      venue: "Innovation Hub",
      latitude: 37.7836,
      longitude: -122.4034,
      category: "tech",
      startTime: d(2),
      endTime: new Date(dMs(2) + 3 * 3_600_000),
      status: "upcoming",
      priceAmount: 2500,
      priceCurrency: "USD",
    }),
    evt("evt_seed_upcoming2", U.bob, {
      title: "Community 5K Run",
      description: "A flat, friendly 5K through the park. All paces welcome.",
      location: "Golden Gate Park, San Francisco",
      venue: "Main Meadow",
      latitude: 37.7694,
      longitude: -122.4862,
      category: "fitness",
      startTime: d(5),
      endTime: new Date(dMs(5) + 2 * 3_600_000),
      status: "upcoming",
    }),
    evt("evt_seed_upcoming3", U.alice, {
      title: "Rooftop Cocktail Mixer",
      description: "Meet founders, designers, and engineers over craft cocktails.",
      location: "Downtown, Los Angeles",
      venue: "Sky Lounge",
      latitude: 34.0522,
      longitude: -118.2437,
      category: "social",
      startTime: d(8),
      endTime: new Date(dMs(8) + 4 * 3_600_000),
      status: "upcoming",
      priceAmount: 1500,
      priceCurrency: "USD",
    }),
    evt("evt_seed_upcoming4", U.bob, {
      title: "Photography Walk – Street Portraits",
      description: "Guided street photography session with portfolio critique at the end.",
      location: "Williamsburg, Brooklyn",
      venue: "Starts at Bedford Ave L",
      latitude: 40.717,
      longitude: -73.9563,
      category: "art",
      startTime: d(12),
      endTime: new Date(dMs(12) + 3 * 3_600_000),
      status: "upcoming",
    }),
    evt("evt_seed_upcoming5", U.me, {
      title: "Indie Film Screening: Short Cuts",
      description:
        "Curated selection of short films from emerging directors, followed by a Q\u0026A.",
      location: "SoHo, New York",
      venue: "IFC Center",
      latitude: 40.728,
      longitude: -74.002,
      category: "film",
      startTime: d(18),
      endTime: new Date(dMs(18) + 2.5 * 3_600_000),
      status: "upcoming",
      priceAmount: 1200,
      priceCurrency: "USD",
    }),
    evt("evt_seed_upcoming6", U.charlie, {
      title: "Board Game Night",
      description: "Bring your favourite game or try one of ours. Pizza provided.",
      location: "East Village, New York",
      venue: "Hex & Co.",
      latitude: 40.7282,
      longitude: -73.9907,
      category: "social",
      startTime: d(3),
      endTime: new Date(dMs(3) + 4 * 3_600_000),
      status: "upcoming",
    }),
    evt("evt_seed_upcoming7", U.faye, {
      title: "Afrobeats Dance Workshop",
      description: "Learn foundational Afrobeats moves. No experience needed.",
      location: "Harlem, New York",
      venue: "Rhythm House",
      latitude: 40.8116,
      longitude: -73.9465,
      category: "fitness",
      startTime: d(4),
      endTime: new Date(dMs(4) + 2 * 3_600_000),
      status: "upcoming",
    }),
    evt("evt_seed_upcoming8", U.priya, {
      title: "Startup Pitch Night",
      description: "Five early-stage founders pitch to a panel. Networking drinks after.",
      location: "Mission District, San Francisco",
      venue: "The Vault",
      latitude: 37.7599,
      longitude: -122.4148,
      category: "tech",
      startTime: d(6),
      endTime: new Date(dMs(6) + 3 * 3_600_000),
      status: "upcoming",
    }),
    evt("evt_seed_upcoming9", U.george, {
      title: "Korean BBQ Cookout",
      description: "Bring your appetite. Galbi, japchae, and cold beer on the rooftop.",
      location: "Koreatown, Los Angeles",
      venue: "Rooftop @ Line Hotel",
      latitude: 34.0611,
      longitude: -118.3009,
      category: "food",
      startTime: d(7),
      endTime: new Date(dMs(7) + 5 * 3_600_000),
      status: "upcoming",
      priceAmount: 3500,
      priceCurrency: "USD",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Seed series
// ---------------------------------------------------------------------------

/**
 * Two example series that exercise the recurring-events surfaces end-to-end:
 *
 *  - srs_seed_yoga: WEEKLY, owned by "me", 8 weekly Tuesday 6pm instances
 *    spread across finished/ongoing/upcoming so the Series page has
 *    populated Past and Upcoming tabs out of the box. Instance w3 is
 *    flagged `instanceOverride=true` with a different title; w5 is
 *    `cancelled` to demo that rendering path.
 *  - srs_seed_book_club: MONTHLY, owned by Alice, 6 first-Thursday
 *    instances. First is `finished`, rest `upcoming`, none overridden.
 */
export function buildSeedSeries(now: Date): NewEventSeries[] {
  const dayMs = 86_400_000;
  // dtstart for yoga = Tuesday 6pm UTC, 3 weeks ago (so past/present/future)
  const yogaStart = new Date(now.getTime() - 21 * dayMs);
  yogaStart.setUTCHours(18, 0, 0, 0);
  // dtstart for book club = 1 month ago (puts first occurrence in the past)
  const bookStart = new Date(now.getTime() - 30 * dayMs);
  bookStart.setUTCHours(19, 0, 0, 0);

  return [
    {
      id: "srs_seed_yoga",
      title: "Sunset Rooftop Yoga — Weekly",
      description: "Vinyasa flow every Tuesday. Drop in any week.",
      location: "Midtown, New York",
      venue: "The High Line Hotel",
      latitude: 40.7473,
      longitude: -74.0027,
      category: "wellness",
      imageUrl: null,
      durationMinutes: 75,
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=8",
      dtstart: yogaStart,
      until: null,
      materializedThrough: new Date(yogaStart.getTime() + 7 * 8 * dayMs),
      timezone: "America/New_York",
      status: "active",
      chatId: null,
      createdByProfileId: U.me.id,
      createdByName: U.me.name,
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "srs_seed_book_club",
      title: "Book Club — First Thursdays",
      description: "Monthly fiction pick. Wine + discussion.",
      location: "Echo Park, Los Angeles",
      venue: "Stories Books & Cafe",
      latitude: 34.0786,
      longitude: -118.2608,
      category: "community",
      imageUrl: null,
      durationMinutes: 120,
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      rrule: "FREQ=MONTHLY;COUNT=6",
      dtstart: bookStart,
      until: null,
      materializedThrough: new Date(bookStart.getTime() + 30 * 6 * dayMs),
      timezone: "America/Los_Angeles",
      status: "active",
      chatId: null,
      createdByProfileId: U.alice.id,
      createdByName: U.alice.name,
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Materialised instance rows for the seed series. Exported so tests can
 * assert without hitting a real DB, and so the seed script inserts a
 * predictable fixture set.
 */
export function buildSeedSeriesInstances(now: Date): NewEvent[] {
  const dayMs = 86_400_000;
  const yogaStart = new Date(now.getTime() - 21 * dayMs);
  yogaStart.setUTCHours(18, 0, 0, 0);
  const bookStart = new Date(now.getTime() - 30 * dayMs);
  bookStart.setUTCHours(19, 0, 0, 0);

  const yogaInstances: NewEvent[] = Array.from({ length: 8 }, (_, i) => {
    const start = new Date(yogaStart.getTime() + i * 7 * dayMs);
    const end = new Date(start.getTime() + 75 * 60_000);
    const status: NewEvent["status"] =
      i === 4
        ? "cancelled"
        : end.getTime() < now.getTime()
          ? "finished"
          : start.getTime() <= now.getTime()
            ? "ongoing"
            : "upcoming";
    const override = i === 2;
    return {
      id: `evt_seed_yoga_w${i + 1}`,
      title: override ? "Sunset Rooftop Yoga — Guest Instructor" : "Sunset Rooftop Yoga",
      description: "Vinyasa flow with panoramic city views.",
      location: "Midtown, New York",
      venue: override ? "The High Line Hotel (Studio B)" : "The High Line Hotel",
      latitude: 40.7473,
      longitude: -74.0027,
      category: "wellness",
      startTime: start,
      endTime: end,
      status,
      imageUrl: null,
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      chatId: null,
      seriesId: "srs_seed_yoga",
      instanceOverride: override,
      createdByProfileId: U.me.id,
      createdByName: U.me.name,
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
  });

  const bookInstances: NewEvent[] = Array.from({ length: 6 }, (_, i) => {
    const start = new Date(bookStart);
    start.setUTCMonth(start.getUTCMonth() + i);
    const end = new Date(start.getTime() + 120 * 60_000);
    const status: NewEvent["status"] = end.getTime() < now.getTime() ? "finished" : "upcoming";
    return {
      id: `evt_seed_book_m${i + 1}`,
      title: "Book Club",
      description: "Monthly fiction pick.",
      location: "Echo Park, Los Angeles",
      venue: "Stories Books & Cafe",
      latitude: 34.0786,
      longitude: -118.2608,
      category: "community",
      startTime: start,
      endTime: end,
      status,
      imageUrl: null,
      visibility: "public",
      guestListVisibility: "public",
      joinPolicy: "open",
      allowInterested: true,
      commsChannels: '["email"]',
      chatId: null,
      seriesId: "srs_seed_book_club",
      instanceOverride: false,
      createdByProfileId: U.alice.id,
      createdByName: U.alice.name,
      createdByAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
  });

  return [...yogaInstances, ...bookInstances];
}

// ---------------------------------------------------------------------------
// Seed RSVPs
// ---------------------------------------------------------------------------

/**
 * Builds RSVP rows. The social graph matters here:
 *
 * "me" is friends with: alice, bob, charlie, dana, eli, faye, george, hana
 * "me" is NOT friends with: ivan, jess, kai, luna, milo, nina (friends-of-friends)
 * "me" is NOT friends with: omar, priya, quinn, rosa, sam (strangers)
 *
 * So when authenticated as "me", events should show friend-attendance for
 * alice/bob/charlie/dana/eli/faye/george/hana RSVPs. Other RSVPs appear
 * as generic attendee counts but not as "friends going".
 */
export function buildSeedRsvps(): NewEventRsvp[] {
  let i = 0;
  const rsvp = (
    eventId: string,
    profileId: string,
    status: "going" | "interested" = "going",
  ): NewEventRsvp => ({
    id: `rsvp_seed_${++i}`,
    eventId,
    profileId,
    status,
    createdAt: new Date(),
  });

  return [
    // ── Farmers Market (ongoing) — popular, lots of friends going ────────
    rsvp("evt_seed_ongoing1", U.me.id),
    rsvp("evt_seed_ongoing1", U.alice.id),
    rsvp("evt_seed_ongoing1", U.charlie.id),
    rsvp("evt_seed_ongoing1", U.dana.id),
    rsvp("evt_seed_ongoing1", U.kai.id),
    rsvp("evt_seed_ongoing1", U.omar.id),

    // ── Hack Day (ongoing) — tech crowd ─────────────────────────────────
    rsvp("evt_seed_ongoing2", U.me.id),
    rsvp("evt_seed_ongoing2", U.bob.id),
    rsvp("evt_seed_ongoing2", U.eli.id),
    rsvp("evt_seed_ongoing2", U.milo.id),
    rsvp("evt_seed_ongoing2", U.priya.id),

    // ── Sunset Yoga (ongoing, created by me) ─────────────────────────────
    rsvp("evt_seed_ongoing3", U.me.id),
    rsvp("evt_seed_ongoing3", U.alice.id),
    rsvp("evt_seed_ongoing3", U.dana.id),
    rsvp("evt_seed_ongoing3", U.hana.id),

    // ── Weekend Pottery (ongoing) ────────────────────────────────────────
    rsvp("evt_seed_ongoing4", U.dana.id),
    rsvp("evt_seed_ongoing4", U.faye.id),
    rsvp("evt_seed_ongoing4", U.luna.id),
    rsvp("evt_seed_ongoing4", U.rosa.id),

    // ── Bun + Effect Workshop (upcoming, created by me) — friends RSVP'd ─
    rsvp("evt_seed_upcoming1", U.me.id),
    rsvp("evt_seed_upcoming1", U.alice.id),
    rsvp("evt_seed_upcoming1", U.bob.id),
    rsvp("evt_seed_upcoming1", U.eli.id),
    rsvp("evt_seed_upcoming1", U.charlie.id),
    rsvp("evt_seed_upcoming1", U.milo.id),
    rsvp("evt_seed_upcoming1", U.priya.id),
    rsvp("evt_seed_upcoming1", U.sam.id),

    // ── Community 5K Run — mixed attendance ──────────────────────────────
    rsvp("evt_seed_upcoming2", U.bob.id),
    rsvp("evt_seed_upcoming2", U.george.id),
    rsvp("evt_seed_upcoming2", U.hana.id),
    rsvp("evt_seed_upcoming2", U.nina.id),
    rsvp("evt_seed_upcoming2", U.quinn.id),
    rsvp("evt_seed_upcoming2", U.me.id, "interested"),

    // ── Rooftop Cocktail Mixer ───────────────────────────────────────────
    rsvp("evt_seed_upcoming3", U.alice.id),
    rsvp("evt_seed_upcoming3", U.dana.id),
    rsvp("evt_seed_upcoming3", U.faye.id),
    rsvp("evt_seed_upcoming3", U.george.id),
    rsvp("evt_seed_upcoming3", U.kai.id),
    rsvp("evt_seed_upcoming3", U.luna.id),
    rsvp("evt_seed_upcoming3", U.me.id),

    // ── Photography Walk ─────────────────────────────────────────────────
    rsvp("evt_seed_upcoming4", U.bob.id),
    rsvp("evt_seed_upcoming4", U.hana.id),
    rsvp("evt_seed_upcoming4", U.nina.id),
    rsvp("evt_seed_upcoming4", U.me.id, "interested"),

    // ── Film Screening (created by me) — some friends interested ─────────
    rsvp("evt_seed_upcoming5", U.me.id),
    rsvp("evt_seed_upcoming5", U.alice.id),
    rsvp("evt_seed_upcoming5", U.charlie.id),
    rsvp("evt_seed_upcoming5", U.eli.id, "interested"),
    rsvp("evt_seed_upcoming5", U.rosa.id),

    // ── Board Game Night — close friends ─────────────────────────────────
    rsvp("evt_seed_upcoming6", U.charlie.id),
    rsvp("evt_seed_upcoming6", U.me.id),
    rsvp("evt_seed_upcoming6", U.alice.id),
    rsvp("evt_seed_upcoming6", U.dana.id),
    rsvp("evt_seed_upcoming6", U.eli.id),
    rsvp("evt_seed_upcoming6", U.faye.id),

    // ── Afrobeats Dance Workshop ─────────────────────────────────────────
    rsvp("evt_seed_upcoming7", U.faye.id),
    rsvp("evt_seed_upcoming7", U.george.id),
    rsvp("evt_seed_upcoming7", U.hana.id),
    rsvp("evt_seed_upcoming7", U.sam.id),
    rsvp("evt_seed_upcoming7", U.me.id, "interested"),

    // ── Startup Pitch Night — strangers + friends-of-friends ─────────────
    rsvp("evt_seed_upcoming8", U.priya.id),
    rsvp("evt_seed_upcoming8", U.milo.id),
    rsvp("evt_seed_upcoming8", U.eli.id),
    rsvp("evt_seed_upcoming8", U.nina.id),
    rsvp("evt_seed_upcoming8", U.quinn.id),

    // ── Korean BBQ Cookout — george's event, lots of friends going ───────
    rsvp("evt_seed_upcoming9", U.george.id),
    rsvp("evt_seed_upcoming9", U.me.id),
    rsvp("evt_seed_upcoming9", U.alice.id),
    rsvp("evt_seed_upcoming9", U.bob.id),
    rsvp("evt_seed_upcoming9", U.hana.id),
    rsvp("evt_seed_upcoming9", U.charlie.id),
    rsvp("evt_seed_upcoming9", U.kai.id),
    rsvp("evt_seed_upcoming9", U.omar.id),

    // ── Weekly yoga series — next upcoming instance has friend attendance ─
    rsvp("evt_seed_yoga_w6", U.me.id),
    rsvp("evt_seed_yoga_w6", U.alice.id),
    rsvp("evt_seed_yoga_w6", U.dana.id),
    rsvp("evt_seed_yoga_w6", U.hana.id),
    rsvp("evt_seed_yoga_w7", U.me.id),
    rsvp("evt_seed_yoga_w7", U.faye.id),
    rsvp("evt_seed_yoga_w8", U.me.id, "interested"),

    // ── Monthly book club — spread across a few upcoming instances ───────
    rsvp("evt_seed_book_m2", U.alice.id),
    rsvp("evt_seed_book_m2", U.charlie.id),
    rsvp("evt_seed_book_m2", U.me.id),
    rsvp("evt_seed_book_m3", U.alice.id),
    rsvp("evt_seed_book_m3", U.eli.id),
  ];
}

// ---------------------------------------------------------------------------
// Run seed
// ---------------------------------------------------------------------------

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

  // Order: venues + series (parent FK targets) → events (one-off + series
  // instances + venue-attached) → lineup slots → RSVPs.
  yield* Effect.tryPromise({
    try: () => db.insert(venues).values(buildSeedVenues(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(eventSeries).values(buildSeedSeries(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  const allEvents = [
    ...buildSeedEvents(now),
    ...buildSeedSeriesInstances(now),
    ...buildSeedVenueEvents(now),
  ];
  yield* Effect.tryPromise({
    try: () => db.insert(events).values(allEvents).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(eventLineup).values(buildSeedLineup(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(eventRsvps).values(buildSeedRsvps()).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  // eslint-disable-next-line no-console -- CLI seed script output
  console.log(
    `Seed complete — ${buildSeedVenues(now).length} venues, 2 series, ${allEvents.length} events, ${buildSeedLineup(now).length} lineup slots, ${buildSeedRsvps().length} RSVPs inserted (existing rows skipped).`,
  );
}).pipe(Effect.provide(DbLive));

// eslint-disable-next-line no-console -- CLI seed script error handler
Effect.runPromise(seed).catch(console.error);
