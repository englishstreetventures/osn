import { Elysia, t } from "elysia";
import { Effect, type Layer } from "effect";
import { DbLive, type Db } from "@pulse/db/service";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  listTodayEvents,
  updateEvent,
} from "../services/events";

const statusEnum = t.Optional(
  t.Union([
    t.Literal("upcoming"),
    t.Literal("ongoing"),
    t.Literal("finished"),
    t.Literal("cancelled"),
  ]),
);

export const createEventsRoutes = (dbLayer: Layer.Layer<Db> = DbLive) =>
  new Elysia({ prefix: "/events" })
    .get(
      "/",
      async ({ query }) => {
        const result = await Effect.runPromise(listEvents(query).pipe(Effect.provide(dbLayer)));
        return { events: result };
      },
      {
        query: t.Object({
          status: statusEnum,
          category: t.Optional(t.String()),
          upcoming: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      },
    )
    .get("/today", async () => {
      const result = await Effect.runPromise(listTodayEvents.pipe(Effect.provide(dbLayer)));
      return { events: result };
    })
    .get(
      "/:id",
      async ({ params, set }) => {
        const result = await Effect.runPromise(
          getEvent(params.id).pipe(
            Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Event not found" };
        }
        return { event: result };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )
    .post(
      "/",
      async ({ body, set }) => {
        const result = await Effect.runPromise(
          createEvent(body).pipe(
            Effect.catchTag("ValidationError", (e) =>
              Effect.sync(() => {
                set.status = 422;
                return { error: String(e.cause) } as const;
              }),
            ),
            Effect.provide(dbLayer),
          ),
        );
        if ("error" in result) return result;
        set.status = 201;
        return { event: result };
      },
      {
        body: t.Object({
          title: t.String(),
          description: t.Optional(t.String()),
          location: t.Optional(t.String()),
          venue: t.Optional(t.String()),
          category: t.Optional(t.String()),
          startTime: t.String({ format: "date-time" }),
          endTime: t.Optional(t.String({ format: "date-time" })),
          status: statusEnum,
          imageUrl: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/:id",
      async ({ params, body, set }) => {
        const result = await Effect.runPromise(
          updateEvent(params.id, body).pipe(
            Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
            Effect.catchTag("ValidationError", (e) =>
              Effect.sync(() => {
                set.status = 422;
                return { error: String(e.cause) } as const;
              }),
            ),
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Event not found" };
        }
        if ("error" in result) return result;
        return { event: result };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          title: t.Optional(t.String()),
          description: t.Optional(t.String()),
          location: t.Optional(t.String()),
          venue: t.Optional(t.String()),
          category: t.Optional(t.String()),
          startTime: t.Optional(t.String({ format: "date-time" })),
          endTime: t.Optional(t.String({ format: "date-time" })),
          status: statusEnum,
          imageUrl: t.Optional(t.String()),
        }),
      },
    )
    .delete(
      "/:id",
      async ({ params, set }) => {
        const result = await Effect.runPromise(
          deleteEvent(params.id).pipe(
            Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
            Effect.provide(dbLayer),
          ),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Event not found" };
        }
        set.status = 204;
        return null;
      },
      {
        params: t.Object({ id: t.String() }),
      },
    );

export const eventsRoutes = createEventsRoutes();
