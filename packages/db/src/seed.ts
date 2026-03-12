import { Effect } from "effect";
import { events } from "./schema";
import { Db, DbLive } from "./service";

const sampleEvents = [
  {
    id: "evt_001",
    title: "Summer Rooftop Party",
    description:
      "Join us for an amazing rooftop party with live DJ, cocktails, and stunning city views. Perfect way to kick off the summer!",
    location: "Melbourne, VIC",
    venue: "Rooftop Bar",
    category: "nightlife",
    startTime: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours from now
    endTime: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6 hours from now
    status: "upcoming" as const,
    imageUrl: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800",
  },
  {
    id: "evt_002",
    title: "Tech Meetup: Building with Bun",
    description:
      "Learn about the latest features in Bun and how to build fast, modern web applications. Networking and pizza included!",
    location: "Sydney, NSW",
    venue: "TechHub Sydney",
    category: "tech",
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
    endTime: new Date(Date.now() + 27 * 60 * 60 * 1000),
    status: "upcoming" as const,
    imageUrl: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800",
  },
  {
    id: "evt_003",
    title: "Sunset Yoga in the Park",
    description:
      "Unwind with a relaxing yoga session as the sun sets. All levels welcome. Bring your own mat or borrow one of ours.",
    location: "Brisbane, QLD",
    venue: "South Bank Parklands",
    category: "wellness",
    startTime: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours from now
    endTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
    status: "upcoming" as const,
    imageUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800",
  },
];

const seed = Effect.gen(function* () {
  const { db } = yield* Db;

  yield* Effect.try({
    try: () => db.delete(events),
    catch: (cause) => new Error(`Delete failed: ${cause}`),
  });

  for (const event of sampleEvents) {
    yield* Effect.try({
      try: () => db.insert(events).values(event),
      catch: (cause) => new Error(`Insert failed: ${cause}`),
    });
  }

  return sampleEvents.length;
});

Effect.runPromise(seed.pipe(Effect.provide(DbLive)))
  .then((count) => console.log(`Seeded ${count} events`))
  .catch(console.error);
