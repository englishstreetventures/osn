import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { CreateTaskBody, ReorderTasksBody, UpdateTaskBody } from "../schemas/tasks";
import { tasksService } from "../services/tasks";

// Sentinel parse hook — same idiom as the other organiser write routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

/**
 * Checklist tasks — READ surface (platform Phase 1, [[platform-plan]] §4.1):
 *
 *   GET /api/organiser/weddings/:weddingId/tasks   (weddingMember — any role incl. viewer)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates with the write gate (weddingEditor). This mirrors the
 * createOrganiserHostsReadRoutes / createOrganiserHostsWriteRoutes sibling
 * pattern already in app.ts.
 */
export const createTaskReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/tasks", async ({ weddingId, set }) => {
        if (!weddingId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        return runCire(
          tasksService.list(weddingId).pipe(
            Effect.map((list) => ({ tasks: list })),
            Effect.provideService(DbService, db),
            Effect.catchAllDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      }),
    );

/**
 * Checklist tasks — WRITE surface (platform Phase 1, [[platform-plan]] §4.1):
 *
 *   POST   /api/organiser/weddings/:weddingId/tasks           (weddingEditor)
 *   PATCH  /api/organiser/weddings/:weddingId/tasks/reorder   (weddingEditor)
 *   PATCH  /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *   DELETE /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *
 * A viewer gets 403 `read_only_role`. The service re-scopes every write by
 * wedding_id, so a cross-tenant task id 404s (`TaskNotInWedding`).
 *
 * NOTE: `/tasks/reorder` is registered BEFORE `/tasks/:taskId` so the literal
 * wins over the param.
 */
export const createTaskWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .post(
          "/tasks",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(CreateTaskBody)(raw);
                const task = yield* tasksService.create({
                  weddingId,
                  title: body.title,
                  timeframeBucket: body.timeframeBucket,
                  notes: body.notes,
                  dueAt: body.dueAt,
                });
                return { task };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .patch(
          "/tasks/reorder",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(ReorderTasksBody)(raw);
                yield* tasksService.reorder(weddingId, body.timeframeBucket, body.orderedIds);
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .patch(
          "/tasks/:taskId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(UpdateTaskBody)(raw);
                const task = yield* tasksService.update({
                  weddingId,
                  taskId: params.taskId,
                  patch: body,
                });
                return { task };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("TaskNotInWedding", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "task_not_found" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .delete("/tasks/:taskId", async ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            tasksService.remove(weddingId, params.taskId).pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.provideService(DbService, db),
              Effect.catchTag("TaskNotInWedding", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "task_not_found" };
                }),
              ),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
