/**
 * Shared TypeBox response schemas for the route groups that answer with a bare
 * `{ error }`: graph, organisations and recommendations.
 *
 * The other file, `routes/auth/response-schemas.ts`, serves everything that
 * funnels failures through `publicError`. The split is by envelope, not by
 * folder — account erasure, account export and profiles live outside
 * `routes/auth/` and still belong there, because `publicError`'s envelope
 * carries an optional human-readable `message` while these routes' `error`
 * field IS the human-readable string. One shared const would have had to be a
 * superset of both, which would document a `message` field that half the API
 * never sends.
 *
 * The same two rules apply here as there.
 *
 * 1. Elysia VALIDATES and CLEANS against `response:` at runtime. A key the
 *    schema doesn't declare is deleted from the body before it is sent, and a
 *    value that doesn't type-check 500s the route. A wrong schema here is a
 *    silent data-loss bug, not a docs bug. Model what the handler actually
 *    returns, not what you wish it returned.
 * 2. The schema is checked against the PRE-serialisation value. A `Date` never
 *    satisfies `t.String({ format: "date-time" })` — the handler has to
 *    `.toISOString()` first.
 */

import { t } from "elysia";

/**
 * The error envelope shared by every group in this file. Unlike the auth
 * surface's `{ error, message }`, `error` here IS the message: the routes pass
 * the caller either a fixed string ("Unauthorized", "Profile not found",
 * "Forbidden", "Too many requests") or the output of `makeSafeError`, which
 * surfaces a tagged domain-error message and swallows everything else.
 *
 * Every status uses it, including 500 — `resolveHandle` / `resolveOrg` catch
 * their own failures, set 500, and the handler returns the same shape.
 */
export const errorResponse = t.Object({
  error: t.String(),
});

/** `{ ok: true }` — what a mutation with nothing to report returns. */
export const okResponse = t.Object({
  ok: t.Boolean(),
});

/**
 * `profileProjection` in `routes/graph.ts` — the three fields the graph is
 * allowed to reveal about somebody else. Email is deliberately absent: a
 * connection list is not an address book, and adding it here would leak it
 * from ten endpoints at once.
 */
export const graphProfileSummary = t.Object({
  id: t.String(),
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
});

/** A connection: the other profile, plus when the two were connected. */
export const graphConnectionSummary = t.Object({
  id: t.String(),
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  connectedAt: t.String({ format: "date-time" }),
});

/**
 * A connection request, incoming or outgoing. Both directions carry the same
 * fields — which profile it concerns is decided by the endpoint, not the body.
 */
export const graphRequestSummary = t.Object({
  id: t.String(),
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  requestedAt: t.String({ format: "date-time" }),
});

/**
 * The return of `getConnectionStatus`. A closed union rather than a plain
 * string, because it genuinely is closed at the service — the four values are
 * the whole type — and a generated client is better off with an enum it can
 * switch over than a string it has to compare.
 */
export const graphConnectionStatus = t.Union([
  t.Literal("none"),
  t.Literal("pending_sent"),
  t.Literal("pending_received"),
  t.Literal("connected"),
]);

/**
 * `orgProjection` in `routes/organisation.ts`. The organisation's own id is
 * deliberately absent — every organisation route addresses it by handle, so
 * publishing the internal id would invite clients to key on something the
 * public surface never accepts back.
 */
export const organisationSummary = t.Object({
  handle: t.String(),
  name: t.String(),
  description: t.Union([t.String(), t.Null()]),
  avatarUrl: t.Union([t.String(), t.Null()]),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

/**
 * A row of the member roster. Narrower than the graph's profile summary: no
 * profile id, because membership is managed by handle throughout.
 *
 * `role` is the same closed union the `organisation_members.role` column
 * declares, and the same one the add/update-role request bodies accept — a
 * client can round-trip a value it read here straight back into a PATCH.
 */
export const organisationMemberSummary = t.Object({
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  role: t.Union([t.Literal("admin"), t.Literal("member")]),
  joinedAt: t.String({ format: "date-time" }),
});

/**
 * `Suggestion` from `services/recommendations.ts` — one card in "people you may
 * know". Addressed by handle, not id, like the organisation surface.
 *
 * `reason` names the STRONGEST signal, not the only one: `sharedOrganisation`
 * can be present alongside `reason: "mutual_connections"`, because the card
 * shows both lines. Read them independently.
 *
 * `mutualCount` is a count, never a list. The connection graph is not
 * enumerable through this endpoint — that is the whole reason the suggestion
 * carries a number instead of the names behind it.
 */
export const suggestionSummary = t.Object({
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  avatarUrl: t.Union([t.String(), t.Null()]),
  mutualCount: t.Number(),
  reason: t.Union([t.Literal("mutual_connections"), t.Literal("shared_organisation")]),
  sharedOrganisation: t.Union([t.Object({ handle: t.String(), name: t.String() }), t.Null()]),
});

/**
 * `ProfileSearchResult` — one person in the typeahead. `connectionStatus` is
 * the same closed union as `graphConnectionStatus`, deliberately: it lets the
 * result row render Connect / Pending / Connected without a second request per
 * result, and a client can hand the value straight to the graph code it
 * already has.
 */
export const profileSearchResult = t.Object({
  handle: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  avatarUrl: t.Union([t.String(), t.Null()]),
  connectionStatus: graphConnectionStatus,
});

/**
 * `OrganisationSearchResult` — one organisation in the typeahead. No id, for
 * the same reason `organisationSummary` has none: every organisation route
 * addresses it by handle.
 */
export const organisationSearchResult = t.Object({
  handle: t.String(),
  name: t.String(),
  avatarUrl: t.Union([t.String(), t.Null()]),
  isMember: t.Boolean(),
});
