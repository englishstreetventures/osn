import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import {
  measureHostResolve,
  metricHostAdded,
  metricHostRemoved,
  metricHostRoleChanged,
} from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { AddHostBody, UpdateHostRoleBody } from "../schemas/host";
import { hostsService } from "../services/hosts";
import type { OsnHandleResolver, OsnProfileDisplayResolver } from "../services/osn-bridge";

const PREFIX = "/api/organiser";

/** Transport failure resolving the OSN handle over ARC (osn-api down / 5xx). */
class OsnHandleLookupError extends Data.TaggedError("OsnHandleLookupError")<{
  reason: string;
}> {}

/**
 * Co-host LISTING — owner OR co-host (weddingMember). A co-host can see who else
 * hosts the wedding from their dashboard; only the owner can change the list
 * (the add/remove instances below are owner-gated). Split from the mutating
 * routes so the read isn't behind the per-IP add limiter.
 */
export const createOrganiserHostsReadRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  resolveOsnProfileDisplays?: OsnProfileDisplayResolver,
) =>
  new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/hosts", ({ weddingId, set }) => {
        if (!weddingId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        return runCire(
          hostsService.list(weddingId).pipe(
            Effect.provideService(DbService, db),
            // Resolve profileId → handle/displayName live over the batch graph
            // endpoint. FAIL-SOFT: the resolver swallows transport failures and
            // returns an empty map, so a missing/unreachable ARC bridge simply
            // leaves the profile id as the on-screen fallback (no 500). The
            // `Effect.tryPromise` catch is a belt-and-braces guard for the same.
            Effect.flatMap((hosts) =>
              Effect.gen(function* () {
                const displays = resolveOsnProfileDisplays
                  ? yield* Effect.tryPromise({
                      try: () => resolveOsnProfileDisplays(hosts.map((h) => h.osnProfileId)),
                      catch: () => null,
                    }).pipe(Effect.orElseSucceed(() => null))
                  : null;
                return {
                  hosts: hosts.map((h) => {
                    const display = displays?.get(h.osnProfileId);
                    return {
                      osnProfileId: h.osnProfileId,
                      // Handle is the display value; profileId stays as the
                      // last-resort fallback when the lookup couldn't resolve it.
                      ...(display ? { handle: display.handle } : {}),
                      ...(display?.displayName ? { displayName: display.displayName } : {}),
                      role: h.role,
                      createdAt: h.createdAt.getTime(),
                    };
                  }),
                };
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

/**
 * Co-host ADD / REMOVE / ROLE CHANGE — owner only (weddingOwner). Split into its own instance
 * so the per-IP rate limiter gates the ARC-sign + S2S handle-resolve amplifier
 * on the add (and the host-management churn on remove) without touching the
 * dashboard reads. The handle is resolved to a profile id server-to-server over
 * ARC; when the bridge is unconfigured the add fails closed with 503 (the same
 * degradation as account-linking).
 */
export const createOrganiserHostsWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnProfileByHandle?: OsnHandleResolver,
) =>
  new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddleware(limiter))
        .post(
          "/hosts",
          async ({ request, weddingId, osnProfileId, set }) => {
            // weddingOwner proved the caller owns :weddingId, so osnProfileId IS
            // the wedding's owner — pass it as both the adder and the owner so
            // the service can reject re-adding the owner as a host.
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            if (!resolveOsnProfileByHandle) {
              // No ARC key configured — adding hosts by handle is disabled, not broken.
              metricHostAdded("disabled");
              set.status = 503;
              return { error: "Adding hosts is not available" };
            }
            const resolveHandle = resolveOsnProfileByHandle;
            const ownerProfileId = osnProfileId;
            const scopedWeddingId = weddingId;

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(AddHostBody)(raw);

                const resolution = yield* Effect.tryPromise({
                  try: () => resolveHandle(body.handle),
                  catch: (cause) => new OsnHandleLookupError({ reason: String(cause) }),
                }).pipe(measureHostResolve);
                if (!resolution.ok) {
                  yield* Effect.sync(() => metricHostAdded("handle_not_found"));
                  set.status = 404;
                  return { error: "No OSN account with that handle" };
                }

                const host = yield* hostsService.add({
                  weddingId: scopedWeddingId,
                  osnProfileId: resolution.profileId,
                  addedByOsnProfileId: ownerProfileId,
                  ownerOsnProfileId: ownerProfileId,
                  role: body.role,
                });

                yield* Effect.sync(() => metricHostAdded("ok"));
                set.status = 201;
                return {
                  host: {
                    osnProfileId: host.osnProfileId,
                    handle: resolution.handle,
                    role: host.role,
                    createdAt: host.createdAt.getTime(),
                  },
                };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  ParseError: () =>
                    Effect.sync(() => {
                      metricHostAdded("error");
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  HostConflict: (err) =>
                    Effect.sync(() => {
                      if (err.reason === "owner_is_host") {
                        metricHostAdded("owner_is_host");
                        set.status = 409;
                        return { error: "owner_is_host" };
                      }
                      metricHostAdded("already_host");
                      set.status = 409;
                      return { error: "already_host" };
                    }),
                  OsnHandleLookupError: (err) =>
                    Effect.logError("osn handle lookup failed", { reason: err.reason }).pipe(
                      Effect.flatMap(() =>
                        Effect.sync(() => {
                          metricHostAdded("osn_unavailable");
                          set.status = 502;
                          return { error: "OSN handle lookup failed" };
                        }),
                      ),
                    ),
                  HostWriteError: () =>
                    Effect.sync(() => {
                      metricHostAdded("error");
                      set.status = 500;
                      return { error: "Could not add host" };
                    }),
                }),
                Effect.catchAllDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          // Sentinel parse hook: stops Elysia consuming the body so the handler
          // parses it by hand — malformed JSON degrades to the schema's 400.
          { parse: () => ({}) },
        )
        // Flip a co-host between editor and viewer. Owner-gated like add/remove
        // — role assignment IS host management. 404 when the profile isn't a
        // co-host of this wedding (covers the owner too: never rowed in).
        .put(
          "/hosts/:osnProfileId/role",
          async ({ request, weddingId, params, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(UpdateHostRoleBody)(raw);
                const host = yield* hostsService.setRole({
                  weddingId,
                  osnProfileId: params.osnProfileId,
                  role: body.role,
                });
                yield* Effect.sync(() => metricHostRoleChanged("ok"));
                return {
                  host: {
                    osnProfileId: host.osnProfileId,
                    role: host.role,
                    createdAt: host.createdAt.getTime(),
                  },
                };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  ParseError: () =>
                    Effect.sync(() => {
                      metricHostRoleChanged("error");
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  HostNotFound: () =>
                    Effect.sync(() => {
                      metricHostRoleChanged("not_found");
                      set.status = 404;
                      return { error: "host_not_found" };
                    }),
                  HostWriteError: () =>
                    Effect.sync(() => {
                      metricHostRoleChanged("error");
                      set.status = 500;
                      return { error: "Could not change role" };
                    }),
                }),
                Effect.catchAllDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          // Sentinel parse hook: stops Elysia consuming the body so the handler
          // parses it by hand — malformed JSON degrades to the schema's 400.
          { parse: () => ({}) },
        )
        .delete("/hosts/:osnProfileId", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            hostsService.remove({ weddingId, osnProfileId: params.osnProfileId }).pipe(
              Effect.provideService(DbService, db),
              Effect.tap(() => Effect.sync(() => metricHostRemoved("ok"))),
              Effect.as({ removed: true, osnProfileId: params.osnProfileId }),
              Effect.catchTag("HostWriteError", () =>
                Effect.sync(() => {
                  metricHostRemoved("error");
                  set.status = 500;
                  return { error: "Could not remove host" };
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
