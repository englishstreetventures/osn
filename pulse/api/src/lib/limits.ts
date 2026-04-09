/**
 * Platform-wide limits for Pulse.
 *
 * These are intentionally exposed as named constants so they can be
 * referenced by schemas, route bodies, documentation, and error messages
 * from a single source of truth. Changing a cap here should be a
 * deliberate, auditable edit — never inline these into a schema.
 */

/**
 * Maximum number of guests any single event can hold across all RSVP
 * statuses. Also used to cap:
 *   - `POST /events/:id/invite` batch size (can't invite more people than
 *     the event can hold)
 *   - `listConnections` / `listCloseFriends` membership sets in
 *     `graphBridge.ts` (a viewer's graph is bounded to MAX_EVENT_GUESTS
 *     for visibility-filter purposes)
 *
 * ## Why 1000?
 *
 * Pulse is designed for social events — house parties, meetups, dinners,
 * community gatherings. 1000 comfortably covers virtually every personal
 * use case and most small-to-medium community events (conferences,
 * weddings, festivals).
 *
 * Beyond 1000, the guest-list visibility filter starts to have
 * meaningful cost at request time, and the event starts looking more
 * like a ticketed production than a social gathering. Those events will
 * eventually be served by a verified-organisation tier with bespoke
 * infrastructure (dashboards, SLA, bulk import/export, paid ticketing —
 * all deferred to Pulse phase 2).
 *
 * ## Raising the cap
 *
 * A single-user organiser cannot raise this. When verified-organisation
 * support lands, accounts with the `org_verified` claim will be able to
 * request bespoke raises on a per-event basis via a support flow (also
 * deferred).
 *
 * If you're about to bump this constant, talk to the team first — it
 * affects rate limits, DB planning, and the free-vs-paid tier boundary.
 */
export const MAX_EVENT_GUESTS = 1000;
