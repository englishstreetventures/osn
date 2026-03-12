import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { DbLive } from "@osn/db/service";
import { listEvents, listTodayEvents, getEvent } from "../services/events";

export const eventsRoutes = new Elysia({ prefix: "/events" })
  .get(
    "/",
    async ({ query }) => {
      const result = await Effect.runPromise(listEvents(query).pipe(Effect.provide(DbLive)));
      return { events: result };
    },
    {
      query: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal("upcoming"),
            t.Literal("ongoing"),
            t.Literal("finished"),
            t.Literal("cancelled"),
          ]),
        ),
        category: t.Optional(t.String()),
        upcoming: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get("/today", async () => {
    const result = await Effect.runPromise(listTodayEvents.pipe(Effect.provide(DbLive)));
    return { events: result };
  })
  .get(
    "/:id",
    async ({ params, set }) => {
      const result = await Effect.runPromise(
        getEvent(params.id).pipe(
          Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
          Effect.provide(DbLive),
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
  );
