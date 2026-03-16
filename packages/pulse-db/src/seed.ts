import { Effect } from "effect";
import { DbLive, Db } from "./service";
import { events } from "./schema";

const seed = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();

  yield* Effect.tryPromise(() =>
    db.insert(events).values([
      {
        id: "evt_rooftop001",
        title: "Rooftop Sunset Party",
        description: "Join us for an evening of music and views.",
        location: "Downtown",
        venue: "Sky Lounge",
        category: "social",
        startTime: new Date("2030-07-15T18:00:00.000Z"),
        endTime: new Date("2030-07-15T23:00:00.000Z"),
        status: "upcoming",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "evt_techmeet02",
        title: "Tech Meetup: Bun & Effect",
        description: "Deep dive into the Bun runtime and Effect.ts.",
        location: "Tech District",
        venue: "Innovation Hub",
        category: "tech",
        startTime: new Date("2030-08-01T19:00:00.000Z"),
        status: "upcoming",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "evt_yoga00003",
        title: "Morning Yoga in the Park",
        description: "Start your day with an outdoor yoga session.",
        location: "Central Park",
        category: "wellness",
        startTime: new Date("2030-06-20T07:00:00.000Z"),
        endTime: new Date("2030-06-20T08:30:00.000Z"),
        status: "upcoming",
        createdAt: now,
        updatedAt: now,
      },
    ]),
  );

  console.log("Seeded 3 events.");
}).pipe(Effect.provide(DbLive));

Effect.runPromise(seed).catch(console.error);
