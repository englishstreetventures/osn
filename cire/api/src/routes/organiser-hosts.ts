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
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
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
            Effect.flatMap(({ hosts, total }) =>
              Effect.gen(function* () {
                const displays = resolveOsnProfileDisplays
                  ? yield* Effect.tryPromise({
                      // Resolve the ADDERS' handles too, so the panel can name
                      // who created each seat rather than printing a profile id.
                      try: () =>
                        resolveOsnProfileDisplays([
                          ...new Set(hosts.flatMap((h) => [h.osnProfileId, h.addedByOsnProfileId])),
                        ]),
                      catch: () => null,
                    }).pipe(Effect.orElseSucceed(() => null))
                  : null;
                return {
                  hosts: hosts.map((h) => {
                    const display = displays?.get(h.osnProfileId);
                    const addedBy = displays?.get(h.addedByOsnProfileId);
                    return {
                      osnProfileId: h.osnProfileId,
                      // Handle is the display value; profileId stays as the
                      // last-resort fallback when the lookup couldn't resolve it.
                      ...(display ? { handle: display.handle } : {}),
                      ...(display?.displayName ? { displayName: display.displayName } : {}),
                      role: h.role,
                      createdAt: h.createdAt.getTime(),
                      // Attribution: `POST /hosts` is open to editors, so a seat
                      // the owner didn't create is a thing they need to be able
                      // to see. Same handle-then-id fallback as above.
                      addedByOsnProfileId: h.addedByOsnProfileId,
                      ...(addedBy ? { addedByHandle: addedBy.handle } : {}),
                    };
                  }),
                  // True row count, so a truncated list can never look complete.
                  total,
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
 * Co-host ADD / REMOVE / ROLE CHANGE. Split into its own instance so the per-IP
 * rate limiter gates the ARC-sign + S2S handle-resolve amplifier on the add (and
 * the host-management churn on remove) without touching the dashboard reads. The
 * handle is resolved to a profile id server-to-server over ARC; when the bridge
 * is unconfigured the add fails closed with 503 (the same degradation as
 * account-linking).
 *
 * **The three routes do NOT share a gate.** Adding is `weddingEditor()` — an
 * editor co-host can grow the team, which is what stops the owner being the
 * single person who has to hand out every claim code. Removing and role-changing
 * stay `weddingOwner()`. The split is deliberate and the line is
 * additive-versus-subtractive:
 *
 *   - An editor's ceiling is `editor`. `role` is `editor | viewer` and the owner
 *     is never rowed into `wedding_hosts`, so there is no seat above the
 *     caller's own to grant. Adding a peer is not escalation.
 *   - An editor cannot remove or demote ANYONE, so they cannot evict the owner's
 *     other co-hosts, cannot demote a rival to `viewer`, and cannot take the
 *     wedding over. The owner keeps `DELETE`, so every addition an editor makes
 *     is reversible by the one person who can't be removed.
 *
 * That asymmetry is the whole safety argument: the worst an editor can do is add
 * someone unwanted, and the owner can always undo it. Same shape as the
 * account-linking route — additive, not a privilege ladder.
 */
export const createOrganiserHostsWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnProfileByHandle?: OsnHandleResolver,
) =>
  new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    // ADD — owner or `editor` co-host.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .post(
          "/hosts",
          async ({ request, weddingId, osnProfileId, weddingOwnerOsnProfileId, set }) => {
            // The caller is the owner OR an editor, so — unlike every earlier
            // cut of this handler — `osnProfileId` is NOT necessarily the
            // wedding's owner. The two ids have separate jobs and must not be
            // conflated: the caller is the audit trail (`added_by`), while the
            // OWNER is what the service compares against to refuse re-adding
            // them as a host. Passing the caller for both would have let an
            // editor row the real owner in as a co-host, after which a later
            // "remove host" would appear to strip the owner from their own
            // wedding. `weddingEditor()` derives the owner id from the same
            // query it already runs for the role.
            if (!weddingId || !osnProfileId || !weddingOwnerOsnProfileId) {
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
            const addedByProfileId = osnProfileId;
            const ownerProfileId = weddingOwnerOsnProfileId;
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
                  addedByOsnProfileId: addedByProfileId,
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
                      // Every refusal is a 409 naming its reason, so the portal
                      // can say which of the three happened. `host_cap_reached`
                      // is the newest: it exists because an unbounded add lets
                      // an editor create seats past the list ceiling, i.e. seats
                      // the owner can neither see nor DELETE — which would break
                      // the reversibility this route's design rests on.
                      metricHostAdded(err.reason);
                      set.status = 409;
                      return { error: err.reason };
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
        ),
    )
    // REMOVE / ROLE CHANGE — owner only. A second `.group` on the same path
    // rather than more routes in the one above: a gate is applied per group, so
    // the only way to run two of them over the same prefix is two groups.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(limiter))
        // Flip a co-host between editor and viewer. Owner-only, unlike the add
        // above — demoting an editor to viewer is a subtractive act, and the
        // asymmetry in this file's header is what keeps an editor from using
        // host management to entrench themselves. 404 when the profile isn't a
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
