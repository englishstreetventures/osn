/**
 * Shared TypeBox response schemas for the non-auth route groups (graph,
 * organisations, profiles, recommendations, erasure, export).
 *
 * The auth groups have their own file, `routes/auth/response-schemas.ts`, and
 * the two are deliberately not merged: the auth surface funnels every failure
 * through `publicError`, so its envelope carries an optional human-readable
 * `message`, while these routes answer with a bare `{ error }` whose value is
 * already the human-readable string. One shared const would have had to be a
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
 * The graph error envelope. Unlike the auth surface's `{ error, message }`,
 * `error` here IS the message: the routes pass the caller either a fixed
 * string ("Unauthorized", "Profile not found", "Too many requests") or the
 * output of `makeSafeError`, which surfaces a tagged `GraphError` /
 * `NotFoundError` message and swallows everything else.
 *
 * Every status in the group uses it, including 500 — `resolveHandle`'s catch
 * sets 500 and the handler then returns the same shape.
 */
export const graphErrorResponse = t.Object({
  error: t.String(),
});

/** `{ ok: true }` — what every graph mutation returns on success. */
export const graphOkResponse = t.Object({
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
