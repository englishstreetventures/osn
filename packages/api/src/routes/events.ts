import { Elysia, t } from "elysia";
import { db, events } from "@osn/db";
import { gte, and, eq } from "drizzle-orm";

export const eventsRoutes = new Elysia({ prefix: "/events" })
  .get(
    "/",
    async ({ query }) => {
      const now = new Date();
      const filters = [];

      if (query.status) {
        filters.push(eq(events.status, query.status));
      }

      if (query.category) {
        filters.push(eq(events.category, query.category));
      }

      if (query.upcoming !== "false") {
        filters.push(gte(events.startTime, now));
      }

      const results = await db
        .select()
        .from(events)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(events.startTime)
        .limit(query.limit ? Number(query.limit) : 20);

      return { events: results };
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
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const results = await db
      .select()
      .from(events)
      .where(and(gte(events.startTime, startOfDay), gte(endOfDay, events.startTime)))
      .orderBy(events.startTime);

    return { events: results };
  })
  .get(
    "/:id",
    async ({ params, error }) => {
      const result = await db.select().from(events).where(eq(events.id, params.id)).limit(1);

      if (result.length === 0) {
        return error(404, { message: "Event not found" });
      }

      return { event: result[0] };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  );
