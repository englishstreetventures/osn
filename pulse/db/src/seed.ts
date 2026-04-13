import { Effect, Data } from "effect";

import { events, eventRsvps } from "./schema";
import type { NewEvent, NewEventRsvp } from "./schema";
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
    }),
  ];
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
  ];
}

// ---------------------------------------------------------------------------
// Run seed
// ---------------------------------------------------------------------------

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

  yield* Effect.tryPromise({
    try: () => db.insert(events).values(buildSeedEvents(now)).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  yield* Effect.tryPromise({
    try: () => db.insert(eventRsvps).values(buildSeedRsvps()).onConflictDoNothing(),
    catch: (cause) => new SeedError({ cause }),
  });

  // eslint-disable-next-line no-console -- CLI seed script output
  console.log("Seed complete — 15 events + 73 RSVPs inserted (existing rows skipped).");
}).pipe(Effect.provide(DbLive));

// eslint-disable-next-line no-console -- CLI seed script error handler
Effect.runPromise(seed).catch(console.error);
