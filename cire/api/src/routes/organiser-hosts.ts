import type { RateLimiterBackend } from "@shared/rate-limit";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { dispatchNotice } from "../lib/owner-notice-email";
import type { OwnerChangedInput, OwnerNotices } from "../lib/owner-notice-email";
import {
  type HostRoleChangeResult,
  measureHostResolve,
  metricHostAdded,
  metricHostRemoved,
  metricHostRoleChanged,
  metricHostRunSheetScopeChanged,
} from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { decideCapability, LISTEN_CAPABILITY } from "../middleware/wedding-role";
import { weddingSeat } from "../middleware/wedding-seat";
import { runCire } from "../observability";
import { AddHostBody, UpdateHostRoleBody, UpdateRunSheetScopeBody } from "../schemas/host";
import { hostsService } from "../services/hosts";
import type {
  HostNotFound,
  HostWriteError,
  LastOwner,
  PeopleLimitReached,
  RunSheetScope,
  WeddingRole,
} from "../services/hosts";
import type {
  OsnBlockCheck,
  OsnHandleResolver,
  OsnProfileDisplayResolver,
} from "../services/osn-bridge";
import { createWeddingSignals, type WeddingSignals } from "../services/realtime";

const PREFIX = "/api/organiser";

/**
 * The 409 for a write the wedding's people limit refused: the count the write
 * saw, the tier's limit, and the tier that would have let it through (`null`
 * when none would) — what the portal words the refusal and its upgrade offer
 * from.
 */
const peopleLimitRefusal = (err: PeopleLimitReached) => ({
  error: "people_limit_reached" as const,
  ...err.peopleLimit,
});

/**
 * A person on the co-host panel. `handle` and `displayName` are absent — not
 * null — when the OSN display lookup couldn't resolve them, and the portal
 * falls back to the profile id. `avatarUrl` is the profile's photo, an https
 * URL, absent when there is none; the portal draws a default empty avatar then.
 */
interface HostPersonDto {
  osnProfileId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

/** A seat — an owner's or a co-host's: a {@link HostPersonDto} plus their role
 *  and the seat's attribution. */
interface HostSeatDto extends HostPersonDto {
  /** The seat's own id (`wedding_hosts.id`): what a checklist task's
   *  `assigneeHostIds` name, so the portal can show who holds a task. */
  hostId: string;
  role: WeddingRole;
  createdAt: number;
  addedByOsnProfileId: string;
  addedByHandle?: string;
  /** How far into the run sheet the seat sees. On a helper's seat only: it is
   *  a helper's setting, and no other role's (see {@link helperScope}). */
  runSheetScope?: RunSheetScope;
}

/**
 * The run-sheet scope to show for a seat: its stored value on a helper's seat,
 * and nothing on any other. An owner, editor or viewer sees the whole run sheet
 * whatever the column holds, so a value there is not a setting and would read
 * as one.
 */
const helperScope = (seat: {
  role: WeddingRole;
  runSheetScope: RunSheetScope;
}): { runSheetScope?: RunSheetScope } =>
  seat.role === "helper" ? { runSheetScope: seat.runSheetScope } : {};

/** The metric label for a role change the service refused or failed. */
function roleChangeFailure(
  err: HostNotFound | LastOwner | PeopleLimitReached | HostWriteError,
): HostRoleChangeResult {
  switch (err._tag) {
    case "HostNotFound":
      return "not_found";
    case "LastOwner":
      return "last_owner";
    case "PeopleLimitReached":
      return "people_limit_reached";
    case "HostWriteError":
      return "error";
  }
}

/** Transport failure resolving the OSN handle over ARC (osn-api down / 5xx). */
class OsnHandleLookupError extends Data.TaggedError("OsnHandleLookupError")<{
  reason: string;
}> {}

/** osn-api could not say whether the candidate and the adding owner have a
 *  block (down, an error status, a timeout, an unreadable answer). */
class OsnBlockCheckError extends Data.TaggedError("OsnBlockCheckError")<{
  reason: string;
}> {}

/** The add's refusal for a handle that names no one it can seat. */
const NO_SUCH_HANDLE = { error: "No OSN account with that handle" } as const;

/**
 * Tell the owners an owner was removed or demoted, once the write has
 * committed. A no-op when notices are not configured.
 */
const notifyOwnerChange = (
  db: Db,
  request: Request,
  notices: OwnerNotices | undefined,
  input: OwnerChangedInput,
): Effect.Effect<void> =>
  notices
    ? dispatchNotice(
        request,
        notices.ownerChanged(input).pipe(Effect.provideService(DbService, db)),
      )
    : Effect.void;

/**
 * Seat LISTING — every member (weddingMember). Owners and co-hosts come back in
 * one list, each with their role, so an owner is shown the same way whether
 * they created the wedding or were invited to own it. Changing the list is the
 * write instance below (add, remove or re-role someone: owners only; leave: any
 * seat holder, for their own seat). Split from the mutating routes so the read
 * isn't behind the per-user host-management limiter.
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
            Effect.flatMap(({ hosts, total, peopleLimit }) =>
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
                      hostId: h.id,
                      osnProfileId: h.osnProfileId,
                      role: h.role,
                      createdAt: h.createdAt.getTime(),
                      // Attribution: any of a wedding's equal owners may seat
                      // someone, so each owner needs to see which seats another
                      // owner created. Same handle-then-id fallback as below.
                      addedByOsnProfileId: h.addedByOsnProfileId,
                      ...helperScope(h),
                    };
                    // Handle is the display value; profileId stays as the
                    // last-resort fallback when the lookup couldn't resolve it.
                    if (display) row.handle = display.handle;
                    if (display?.displayName) row.displayName = display.displayName;
                    if (display?.avatarUrl) row.avatarUrl = display.avatarUrl;
                    if (addedBy) row.addedByHandle = addedBy.handle;
                    return row;
                  }),
                  // True row count, so a truncated list can never look complete.
                  total,
                  // Shown to every member as "4 of 6 people"; an owner at the
                  // limit is offered `peopleLimit.tier` instead of the add form.
                  peopleLimit,
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
 * per-user rate limiter gates the ARC-sign + S2S handle-resolve amplifier on the
 * add (and the host-management churn on remove) without touching the dashboard
 * reads. The handle is resolved to a profile id server-to-server over ARC; when
 * the bridge is unconfigured the add fails closed with 503 (the same
 * degradation as account-linking).
 *
 * **No one is seated who has a block with the owner adding them**, either way
 * round, asked of osn-api (`either-blocked`) before the write. The refusal is
 * the same 404 as an unknown handle, so it does not say a block exists; a
 * candidate who already holds a seat gets the usual 409 `already_host`
 * instead, as an unblocked one would. The add fails closed: with no block
 * check configured it answers 503 before the handle is resolved, and when
 * osn-api cannot answer the check (down, an error, a timeout) it answers 502
 * and seats no one. Only the adding owner is checked, not the wedding's other
 * owners: owners can be seated without their consent, so checking them would
 * let an owner learn whether two other people have a block.
 *
 * **Host management is owner-only.** Adding a seat at any role, changing a
 * role, setting a helper's run-sheet scope and removing a seat are all
 * `weddingOwner()`: an editor gets 403 `forbidden` for every one of them.
 * Leaving (`DELETE /hosts/me`) is the one exception, behind `weddingSeat()`:
 * any seat holder, a `helper` too, over their own seat only — the route takes
 * no profile id, so it cannot reach anyone else's.
 *
 * Owners are equals. Any owner may seat someone at any role, `owner` included,
 * demote or remove another owner, or step down or leave themselves; what no one
 * may do is leave the wedding with no owner (409 `last_owner`, enforced in the
 * writing statement itself).
 *
 * Each write that changed a seat — its role, or a helper's run-sheet scope —
 * then tells the wedding's open tabs (`signals.membersChanged`). A removal and
 * a leave also revoke that member's sockets: they close with 1008 and the tab
 * stops listening. So would a role change to one that may not listen
 * (`LISTEN_CAPABILITY`), which no role is today; any other change leaves their
 * sockets open, since a check could only admit them again.
 */
export const createOrganiserHostsWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnProfileByHandle?: OsnHandleResolver,
  osnBlockCheck?: OsnBlockCheck,
  ownerNotices?: OwnerNotices,
  signals: WeddingSignals = createWeddingSignals(undefined),
) =>
  new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    // ADD / REMOVE / ROLE CHANGE / RUN-SHEET SCOPE — owners only.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .post(
          "/hosts",
          async ({ request, weddingId, osnProfileId, set }) => {
            // The caller is an owner, who may grant any role; their id is the
            // audit trail (`added_by`).
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            if (!resolveOsnProfileByHandle || !osnBlockCheck) {
              // No ARC key configured — adding hosts by handle is disabled, not
              // broken. Without the block check no one is seated at all.
              metricHostAdded("disabled");
              set.status = 503;
              return { error: "Adding hosts is not available" };
            }
            const resolveHandle = resolveOsnProfileByHandle;
            const checkBlock = osnBlockCheck;
            const addedByProfileId = osnProfileId;
            const scopedWeddingId = weddingId;

            const raw: unknown = await request.json().catch(() => null);

            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(AddHostBody)(raw);

                const resolution = yield* Effect.tryPromise({
                  try: () => resolveHandle(body.handle),
                  catch: (cause) => new OsnHandleLookupError({ reason: String(cause) }),
                }).pipe(measureHostResolve);
                if (!resolution.ok) {
                  yield* Effect.sync(() => metricHostAdded("handle_not_found", body.role));
                  set.status = 404;
                  return NO_SUCH_HANDLE;
                }

                // An owner adding themselves is answered `already_host` by the
                // write; a profile can hold no block against itself.
                if (resolution.profileId !== addedByProfileId) {
                  const blocked = yield* Effect.tryPromise({
                    try: () => checkBlock(resolution.profileId, addedByProfileId),
                    catch: (cause) => new OsnBlockCheckError({ reason: String(cause) }),
                  }).pipe(Effect.withSpan("cire.host.block_check"));
                  if (blocked) {
                    // A seated candidate is answered as any re-add is, so the
                    // refusal says nothing a list of the seats does not. A
                    // wedding deleted since the gate reads as no seat.
                    const seat = yield* hostsService.authorize(
                      scopedWeddingId,
                      resolution.profileId,
                    );
                    if (seat !== null && seat.hostId !== null) {
                      yield* Effect.sync(() => metricHostAdded("already_host", body.role));
                      set.status = 409;
                      return { error: "already_host" as const };
                    }
                    yield* Effect.sync(() => metricHostAdded("blocked", body.role));
                    set.status = 404;
                    return NO_SUCH_HANDLE;
                  }
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
                          err._tag === "HostConflict"
                            ? err.reason
                            : err._tag === "PeopleLimitReached"
                              ? "people_limit_reached"
                              : "error",
                          body.role,
                        ),
                      ),
                    ),
                  );

                yield* Effect.sync(() => metricHostAdded("ok", host.role));
                yield* signals.membersChanged(scopedWeddingId, request);
                // A new owner holds every owner power; the other owners hear of it.
                if (host.role === "owner") {
                  yield* notifyOwnerChange(db, request, ownerNotices, {
                    weddingId: scopedWeddingId,
                    actorOsnProfileId: addedByProfileId,
                    subjectOsnProfileId: host.osnProfileId,
                    change: "added",
                  });
                }
                set.status = 201;
                return {
                  host: {
                    osnProfileId: host.osnProfileId,
                    handle: resolution.handle,
                    role: host.role,
                    createdAt: host.createdAt.getTime(),
                  },
                  peopleLimit: host.peopleLimit,
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
                      // can say which happened: `already_host`, or
                      // `host_cap_reached` — the cap keeps every seat on the
                      // list, where an owner can see it and remove it. Counted
                      // where the service failed, with the role.
                      set.status = 409;
                      return { error: err.reason };
                    }),
                  PeopleLimitReached: (err) =>
                    Effect.sync(() => {
                      set.status = 409;
                      return peopleLimitRefusal(err);
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
                  // Fail closed: no answer is not a "no block". Same 502 and
                  // body as a failed handle lookup, which the portal words as
                  // "try again".
                  OsnBlockCheckError: (err) =>
                    Effect.logError("osn block check failed", { reason: err.reason }).pipe(
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
        )
        // Set any seat's role to any assignable one, an owner's included — the
        // caller's own is how an owner steps down, which is always allowed
        // while another owner remains. 404 when the profile holds no seat on
        // this wedding; 409 `last_owner` when the change would leave it with no
        // owner; 409 `people_limit_reached` when moving ANOTHER owner below
        // owner would pass the tier's people limit. A role change never adds a
        // seat, so the host cap has nothing to say about it.
        .put(
          "/hosts/:osnProfileId/role",
          async ({ request, weddingId, osnProfileId, params, set }) => {
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const actorOsnProfileId = osnProfileId;
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(UpdateHostRoleBody)(raw);
                const host = yield* hostsService
                  .setRole({
                    weddingId,
                    osnProfileId: params.osnProfileId,
                    role: body.role,
                    actorOsnProfileId,
                  })
                  .pipe(
                    Effect.tapError((err) =>
                      Effect.sync(() => metricHostRoleChanged(roleChangeFailure(err), body.role)),
                    ),
                  );
                yield* Effect.sync(() => metricHostRoleChanged("ok", host.role));
                // Every open tab hears of a real change. The member's own
                // sockets close for good only if the new role may not listen;
                // every role reads the run sheet today, so a move to helper
                // keeps their tab listening while its re-read drops the
                // dashboard.
                if (host.previousRole !== host.role) {
                  yield* signals.membersChanged(
                    weddingId,
                    request,
                    decideCapability(host.role, LISTEN_CAPABILITY).allowed
                      ? []
                      : [host.osnProfileId],
                  );
                }
                // An owner moved below owner, the caller's own step-down
                // included, or a seat moved up to owner: every owner hears of
                // it, and a demoted owner does too.
                if (host.previousRole === "owner" && host.role !== "owner") {
                  yield* notifyOwnerChange(db, request, ownerNotices, {
                    weddingId,
                    actorOsnProfileId,
                    subjectOsnProfileId: host.osnProfileId,
                    change: "demoted",
                    newRole: host.role,
                    subjectSeat: host,
                  });
                } else if (host.previousRole !== "owner" && host.role === "owner") {
                  yield* notifyOwnerChange(db, request, ownerNotices, {
                    weddingId,
                    actorOsnProfileId,
                    subjectOsnProfileId: host.osnProfileId,
                    change: "promoted",
                  });
                }
                return {
                  host: {
                    osnProfileId: host.osnProfileId,
                    role: host.role,
                    createdAt: host.createdAt.getTime(),
                    // The change reset the scope unless a helper stayed one,
                    // and only the stored role says which. The panel shows the
                    // seat's scope from here, not from the list it read.
                    ...helperScope(host),
                  },
                  peopleLimit: host.peopleLimit,
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
                  PeopleLimitReached: (err) =>
                    Effect.sync(() => {
                      set.status = 409;
                      return peopleLimitRefusal(err);
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
        // Open a helper's run sheet to every task and who holds it (`full`), or
        // narrow it back to their own tasks (`own`). 404 when the profile holds
        // no seat on this wedding; 409 `not_a_helper` when the seat holds any
        // other role, for which the scope means nothing. The helper's next read
        // of the run sheet is scoped by what this wrote.
        .put(
          "/hosts/:osnProfileId/run-sheet-scope",
          async ({ request, weddingId, osnProfileId, params, set }) => {
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(UpdateRunSheetScopeBody)(raw);
                const host = yield* hostsService
                  .setRunSheetScope({
                    weddingId,
                    osnProfileId: params.osnProfileId,
                    scope: body.scope,
                  })
                  .pipe(
                    Effect.tapError((err) =>
                      Effect.sync(() =>
                        metricHostRunSheetScopeChanged(
                          err._tag === "HostNotFound"
                            ? "not_found"
                            : err._tag === "NotAHelper"
                              ? "not_a_helper"
                              : "error",
                          body.scope,
                        ),
                      ),
                    ),
                  );
                yield* Effect.sync(() => metricHostRunSheetScopeChanged("ok", host.runSheetScope));
                // The helper's open tab, and every co-host panel, re-read. Nobody
                // is closed: narrowed or widened, the helper still listens.
                if (host.changed) yield* signals.membersChanged(weddingId, request);
                return {
                  host: {
                    osnProfileId: host.osnProfileId,
                    role: host.role,
                    runSheetScope: host.runSheetScope,
                  },
                };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  SchemaError: () =>
                    Effect.sync(() => {
                      metricHostRunSheetScopeChanged("error");
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  HostNotFound: () =>
                    Effect.sync(() => {
                      set.status = 404;
                      return { error: "host_not_found" };
                    }),
                  NotAHelper: () =>
                    Effect.sync(() => {
                      set.status = 409;
                      return { error: "not_a_helper" };
                    }),
                  HostWriteError: () =>
                    Effect.sync(() => {
                      set.status = 500;
                      return { error: "Could not change what they see" };
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
        .delete("/hosts/:osnProfileId", ({ request, weddingId, osnProfileId, params, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            // The panel shows the new people count from this answer.
            hostsService
              .remove({ weddingId, osnProfileId: params.osnProfileId, withPeopleLimit: true })
              .pipe(
                Effect.provideService(DbService, db),
                Effect.tap(() => Effect.sync(() => metricHostRemoved("ok", "owner"))),
                // Only when a seat went: removing a profile that holds none
                // changes nobody's access.
                Effect.tap(({ removed }) =>
                  removed
                    ? signals.membersChanged(weddingId, request, [params.osnProfileId])
                    : Effect.void,
                ),
                Effect.tap(({ removed }) =>
                  removed?.role === "owner"
                    ? notifyOwnerChange(db, request, ownerNotices, {
                        weddingId,
                        actorOsnProfileId: osnProfileId,
                        subjectOsnProfileId: params.osnProfileId,
                        change: "removed",
                        subjectSeat: removed,
                      })
                    : Effect.void,
                ),
                Effect.map(({ peopleLimit }) => ({
                  removed: true,
                  osnProfileId: params.osnProfileId,
                  peopleLimit,
                })),
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
    // second `.group` on the same path, because a gate is applied per group,
    // and this is a second gate. The static `/hosts/me` path is
    // matched ahead of the owner group's `/hosts/:osnProfileId`, and each
    // group's gate runs only for its own routes, so the owner gate never sees
    // this request.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingSeat(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .delete("/hosts/me", ({ request, weddingId, osnProfileId, set }) => {
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
              Effect.tap(({ removed }) =>
                removed ? signals.membersChanged(weddingId, request, [osnProfileId]) : Effect.void,
              ),
              Effect.tap(({ removed }) =>
                removed?.role === "owner"
                  ? notifyOwnerChange(db, request, ownerNotices, {
                      weddingId,
                      actorOsnProfileId: osnProfileId,
                      subjectOsnProfileId: osnProfileId,
                      change: "removed",
                    })
                  : Effect.void,
              ),
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
