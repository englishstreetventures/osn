import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import {
  type HostRoleChangeResult,
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
import { mayAssignRole } from "../middleware/wedding-role";
import { weddingSeat } from "../middleware/wedding-seat";
import { runCire } from "../observability";
import { AddHostBody, UpdateHostRoleBody } from "../schemas/host";
import { hostsService } from "../services/hosts";
import type {
  HostConflict,
  HostNotFound,
  HostWriteError,
  LastOwner,
  WeddingRole,
} from "../services/hosts";
import type { OsnHandleResolver, OsnProfileDisplayResolver } from "../services/osn-bridge";

const PREFIX = "/api/organiser";

/**
 * A person on the co-host panel. `handle` and `displayName` are absent — not
 * null — when the OSN display lookup couldn't resolve them, and the portal
 * falls back to the profile id.
 */
interface HostPersonDto {
  osnProfileId: string;
  handle?: string;
  displayName?: string;
}

/** A seat — an owner's or a co-host's: a {@link HostPersonDto} plus their role
 *  and the seat's attribution. */
interface HostSeatDto extends HostPersonDto {
  role: WeddingRole;
  createdAt: number;
  addedByOsnProfileId: string;
  addedByHandle?: string;
}

/** The metric label for a role change the service refused or failed. */
function roleChangeFailure(
  err: HostNotFound | LastOwner | HostConflict | HostWriteError,
): HostRoleChangeResult {
  switch (err._tag) {
    case "HostNotFound":
      return "not_found";
    case "LastOwner":
      return "last_owner";
    case "HostConflict":
      // A role change never inserts, so the unique index cannot refuse it;
      // `already_host` reaching here would be a fault, and is counted as one.
      return err.reason === "already_host" ? "error" : err.reason;
    case "HostWriteError":
      return "error";
  }
}

/** Transport failure resolving the OSN handle over ARC (osn-api down / 5xx). */
class OsnHandleLookupError extends Data.TaggedError("OsnHandleLookupError")<{
  reason: string;
}> {}

/**
 * Seat LISTING — every member (weddingMember). Owners and co-hosts come back in
 * one list, each with their role, so an owner is shown the same way whether
 * they created the wedding or were invited to own it. Changing the list is the
 * write instance below (add: owner or editor; remove or re-role someone: owner
 * only; leave: any seat holder, for their own seat). Split from the mutating
 * routes so the read isn't behind the per-user host-management limiter.
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
                    const row: HostSeatDto = {
                      osnProfileId: h.osnProfileId,
                      role: h.role,
                      createdAt: h.createdAt.getTime(),
                      // Attribution: `POST /hosts` is open to editors, so a seat
                      // no owner created is a thing owners need to be able to
                      // see. Same handle-then-id fallback as below.
                      addedByOsnProfileId: h.addedByOsnProfileId,
                    };
                    // Handle is the display value; profileId stays as the
                    // last-resort fallback when the lookup couldn't resolve it.
                    if (display) row.handle = display.handle;
                    if (display?.displayName) row.displayName = display.displayName;
                    if (addedBy) row.addedByHandle = addedBy.handle;
                    return row;
                  }),
                  // True row count, so a truncated list can never look complete.
                  total,
                };
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

/**
 * Seat ADD / REMOVE / ROLE CHANGE / LEAVE. Split into its own instance so the
 * per-user rate limiter gates the ARC-sign + S2S handle-resolve amplifier on the add (and
 * the host-management churn on remove) without touching the dashboard reads. The
 * handle is resolved to a profile id server-to-server over ARC; when the bridge
 * is unconfigured the add fails closed with 503 (the same degradation as
 * account-linking).
 *
 * **The routes do NOT share a gate.** Adding is `weddingEditor()` — an
 * editor co-host can grow the team, which is what stops the owners being the
 * only people who can hand out claim codes. Removing and role-changing someone
 * else stay `weddingOwner()`. Leaving (`DELETE /hosts/me`) is `weddingSeat()`:
 * any seat holder, a `helper` too. The split is deliberate and the line is
 * additive-versus-subtractive:
 *
 *   - An editor's ceiling is `editor` (`assignableRolesFor()`): adding a peer
 *     is not escalation, and adding a `viewer` or a `helper` is less than one.
 *     Seating an OWNER is refused to them with 403 `owner_role_forbidden`, since
 *     an owner can remove every other seat and so would undo the reversal the
 *     next point rests on.
 *   - An editor cannot remove or demote anyone else, so they cannot evict
 *     anyone, cannot demote a rival, and cannot take the wedding over. Owners
 *     keep `DELETE /hosts/:osnProfileId`, so every addition an editor makes is
 *     reversible by an owner.
 *   - Leaving is subtractive only over the caller's own seat: the route takes
 *     no profile id, so it cannot reach anyone else's. An owner may leave while
 *     another owner remains; the last owner is refused (409 `last_owner`) by the
 *     same guarded statement every removal runs.
 *
 * That asymmetry is the whole safety argument: the worst an editor can do is add
 * someone unwanted, and an owner can always undo it. Same shape as the
 * account-linking route — additive, not a privilege ladder.
 *
 * Owners are equals. Any owner may seat another owner, demote or remove one, or
 * step down themselves; what no one may do is leave the wedding with no owner
 * (409 `last_owner`, enforced in the writing statement itself).
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
          async ({ request, weddingId, osnProfileId, weddingRole, set }) => {
            // The caller is an owner OR an editor; their id is the audit trail
            // (`added_by`) and their role bounds what they may grant.
            if (!weddingId || !osnProfileId || !weddingRole) {
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
            const callerRole = weddingRole;
            const scopedWeddingId = weddingId;

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(AddHostBody)(raw);

                // Asked before the handle lookup, so a refused grant costs no
                // S2S call and says nothing about whether the handle exists.
                if (!mayAssignRole(callerRole, body.role)) {
                  yield* Effect.sync(() => metricHostAdded("owner_role_forbidden", body.role));
                  set.status = 403;
                  return { error: "owner_role_forbidden" };
                }

                const resolution = yield* Effect.tryPromise({
                  try: () => resolveHandle(body.handle),
                  catch: (cause) => new OsnHandleLookupError({ reason: String(cause) }),
                }).pipe(measureHostResolve);
                if (!resolution.ok) {
                  yield* Effect.sync(() => metricHostAdded("handle_not_found", body.role));
                  set.status = 404;
                  return { error: "No OSN account with that handle" };
                }

                const host = yield* hostsService
                  .add({
                    weddingId: scopedWeddingId,
                    osnProfileId: resolution.profileId,
                    addedByOsnProfileId: addedByProfileId,
                    role: body.role,
                  })
                  .pipe(
                    Effect.tapError((err) =>
                      Effect.sync(() =>
                        metricHostAdded(
                          err._tag === "HostConflict" ? err.reason : "error",
                          body.role,
                        ),
                      ),
                    ),
                  );

                yield* Effect.sync(() => metricHostAdded("ok", host.role));
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
                  SchemaError: () =>
                    Effect.sync(() => {
                      metricHostAdded("error");
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  HostConflict: (err) =>
                    Effect.sync(() => {
                      // Every refusal is a 409 naming its reason, so the portal
                      // can say which happened. The two caps exist because an
                      // unbounded add lets an editor create seats past the list
                      // ceiling, i.e. seats no owner can see or DELETE — which
                      // would break the reversibility this route's design rests
                      // on. Counted where the service failed, with the role.
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
                      set.status = 500;
                      return { error: "Could not add host" };
                    }),
                }),
                Effect.catchDefect(() =>
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
    // REMOVE / ROLE CHANGE — owners only. A second `.group` on the same path
    // rather than more routes in the one above: a gate is applied per group, so
    // the only way to run two of them over the same prefix is two groups.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(limiter))
        // Set any seat's role to any assignable one, an owner's included — the
        // caller's own is how an owner steps down. Owner-only, unlike the add
        // above — moving a seat down is a subtractive act, and the asymmetry in
        // this file's header is what keeps an editor from using host
        // management to entrench themselves. 404 when the profile holds no seat
        // on this wedding; 409 `last_owner` when the change would leave it with
        // no owner; 409 `owner_cap_reached` / `host_cap_reached` when the
        // ceiling the seat would move into is full.
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
                const body = yield* Schema.decodeUnknownEffect(UpdateHostRoleBody)(raw);
                const host = yield* hostsService
                  .setRole({
                    weddingId,
                    osnProfileId: params.osnProfileId,
                    role: body.role,
                  })
                  .pipe(
                    Effect.tapError((err) =>
                      Effect.sync(() => metricHostRoleChanged(roleChangeFailure(err), body.role)),
                    ),
                  );
                yield* Effect.sync(() => metricHostRoleChanged("ok", host.role));
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
                  SchemaError: () =>
                    Effect.sync(() => {
                      metricHostRoleChanged("error");
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  HostNotFound: () =>
                    Effect.sync(() => {
                      set.status = 404;
                      return { error: "host_not_found" };
                    }),
                  LastOwner: () =>
                    Effect.sync(() => {
                      set.status = 409;
                      return { error: "last_owner" };
                    }),
                  HostConflict: (err) =>
                    Effect.sync(() => {
                      set.status = 409;
                      return { error: err.reason };
                    }),
                  HostWriteError: () =>
                    Effect.sync(() => {
                      set.status = 500;
                      return { error: "Could not change role" };
                    }),
                }),
                Effect.catchDefect(() =>
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
        // Remove any seat — a co-host's, another owner's, or the caller's own.
        // 409 `last_owner` when it is the wedding's only owner.
        .delete("/hosts/:osnProfileId", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            hostsService.remove({ weddingId, osnProfileId: params.osnProfileId }).pipe(
              Effect.provideService(DbService, db),
              Effect.tap(() => Effect.sync(() => metricHostRemoved("ok", "owner"))),
              Effect.as({ removed: true, osnProfileId: params.osnProfileId }),
              Effect.catchTags({
                LastOwner: () =>
                  Effect.sync(() => {
                    metricHostRemoved("last_owner", "owner");
                    set.status = 409;
                    return { error: "last_owner" };
                  }),
                HostWriteError: () =>
                  Effect.sync(() => {
                    metricHostRemoved("error", "owner");
                    set.status = 500;
                    return { error: "Could not remove host" };
                  }),
              }),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    )
    // LEAVE — any seat holder, `helper` included, for their own seat only. A
    // third group because it is a third gate. The static `/hosts/me` path is
    // matched ahead of the owner group's `/hosts/:osnProfileId`, and each
    // group's gate runs only for its own routes, so the owner gate never sees
    // this request.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingSeat(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .delete("/hosts/me", ({ weddingId, osnProfileId, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          // The same guarded removal as an owner's: an owner may leave while
          // another owner remains, and the last owner is refused 409
          // `last_owner` — promote someone first, or delete the wedding.
          return runCire(
            hostsService.remove({ weddingId, osnProfileId }).pipe(
              Effect.provideService(DbService, db),
              Effect.tap(() => Effect.sync(() => metricHostRemoved("ok", "self"))),
              Effect.as({ left: true }),
              Effect.catchTags({
                LastOwner: () =>
                  Effect.sync(() => {
                    metricHostRemoved("last_owner", "self");
                    set.status = 409;
                    return { error: "last_owner" };
                  }),
                HostWriteError: () =>
                  Effect.sync(() => {
                    metricHostRemoved("error", "self");
                    set.status = 500;
                    return { error: "Could not leave this wedding" };
                  }),
              }),
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
