import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { CHECKLIST_TEMPLATES, isChecklistTemplateId } from "../lib/checklist-templates";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import {
  ApplyTemplateBody,
  AssignTaskBody,
  CreateTaskBody,
  ReorderTasksBody,
  UpdateTaskBody,
} from "../schemas/tasks";
import { taskTemplatesService } from "../services/task-templates";
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
 *
 * The checklist is a Gold module: this read and every write sit behind
 * `weddingTier(db, "gold")`, so a wedding below Gold gets 402
 * `payment_required` and its tasks stay where they are.
 */
export const createTaskReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(weddingTier(db, "gold"))
        .get("/tasks", async ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            tasksService.list(weddingId).pipe(
              Effect.map((list) => ({ tasks: list })),
              Effect.provideService(DbService, db),
              Effect.catchDefect(() =>
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
 *   GET    /api/organiser/weddings/:weddingId/tasks/templates/:templateId (weddingEditor)
 *   POST   /api/organiser/weddings/:weddingId/tasks/templates/:templateId (weddingEditor)
 *   PATCH  /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *   PUT    /api/organiser/weddings/:weddingId/tasks/:taskId/assignee (weddingEditor)
 *   DELETE /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *
 * The template preview is a read, but it sits here: it shows what applying
 * would add, which only someone who may apply has a use for.
 *
 * A viewer gets 403 `read_only_role`; a wedding below Gold gets 402
 * `payment_required`. The service re-scopes every write by
 * wedding_id, so a cross-tenant task id 404s (`TaskNotInWedding`), and the
 * assignee write takes only a seat of the same wedding: anything else is 422
 * `assignee_not_in_wedding` (`HostNotInWedding`), with nothing written.
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
        .use(weddingTier(db, "gold"))
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
                const body = yield* Schema.decodeUnknownEffect(CreateTaskBody)(raw);
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
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchDefect(() =>
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
                const body = yield* Schema.decodeUnknownEffect(ReorderTasksBody)(raw);
                yield* tasksService.reorder(weddingId, body.timeframeBucket, body.orderedIds);
                return { ok: true as const };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchDefect(() =>
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
        .get("/tasks/templates/:templateId", async ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const { templateId } = params;
          if (!isChecklistTemplateId(templateId)) {
            set.status = 404;
            return { error: "template_not_found" };
          }
          return runCire(
            taskTemplatesService.preview(weddingId, templateId).pipe(
              Effect.map((preview) => ({ preview })),
              Effect.provideService(DbService, db),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        .post(
          "/tasks/templates/:templateId",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const { templateId } = params;
            if (!isChecklistTemplateId(templateId)) {
              set.status = 404;
              return { error: "template_not_found" };
            }
            const raw: unknown = await request.json().catch(() => null);
            const known = new Set(CHECKLIST_TEMPLATES[templateId].map((item) => item.key));
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(ApplyTemplateBody)(raw);
                if (!body.items.every((key) => known.has(key))) {
                  set.status = 400;
                  return { error: "Missing or invalid fields" };
                }
                return yield* taskTemplatesService.apply({
                  weddingId,
                  templateId,
                  keys: body.items,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchDefect(() =>
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
                const body = yield* Schema.decodeUnknownEffect(UpdateTaskBody)(raw);
                const task = yield* tasksService.update({
                  weddingId,
                  taskId: params.taskId,
                  patch: body,
                });
                return { task };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
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
                Effect.catchDefect(() =>
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
        .put(
          "/tasks/:taskId/assignee",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(AssignTaskBody)(raw);
                const task = yield* tasksService.assign(
                  weddingId,
                  params.taskId,
                  body.assignedHostId,
                );
                return { task };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
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
                Effect.catchTag("HostNotInWedding", () =>
                  Effect.sync(() => {
                    set.status = 422;
                    return { error: "assignee_not_in_wedding" };
                  }),
                ),
                Effect.catchDefect(() =>
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
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
