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

/**
 * Maximum duration, in hours, from `startTime` to `endTime` for any
 * single event with an *explicit* endTime. Enforced server-side in
 * `createEvent` and `updateEvent` as a defence-in-depth check behind
 * the client-side duration picker — a client that bypasses the picker
 * and POSTs a 30-year-long event should still fail validation.
 *
 * Events *without* an endTime are governed by a separate, tighter
 * ladder: see `MAYBE_FINISHED_AFTER_HOURS` / `AUTO_CLOSE_NO_END_TIME_HOURS`.
 *
 * ## Why 48h?
 *
 * Pulse is designed for social events — parties, meetups, dinners,
 * weekend trips. 48h (two days) comfortably covers weekend-long
 * gatherings while rejecting obvious abuse (an "event" that runs for a
 * year is not an event). Multi-day festivals and conferences are served
 * by the verified-organisation tier deferred to Pulse phase 2.
 *
 * ## Raising the cap
 *
 * Same rules as `MAX_EVENT_GUESTS` — bump requires sign-off. It
 * interacts with the on-read status-transition logic (`applyTransition`
 * in `services/events.ts`), which reads `endTime` to decide when an
 * event has `"finished"`.
 */
export const MAX_EVENT_DURATION_HOURS = 48;

/**
 * Hours past `startTime` after which an event that was created
 * *without* an explicit `endTime` auto-transitions to
 * `"maybe_finished"`. This is a soft signal to guests that the event
 * has probably wrapped — the organiser can still mark it finished
 * earlier, or leave it alone until the auto-close kicks in
 * (`AUTO_CLOSE_NO_END_TIME_HOURS`).
 */
export const MAYBE_FINISHED_AFTER_HOURS = 8;

/**
 * Hours past `startTime` after which an event that was created
 * *without* an explicit `endTime` auto-transitions to `"finished"`.
 * Tighter than `MAX_EVENT_DURATION_HOURS` because an organiser who
 * declined to set an endTime is implicitly accepting a shorter, best-
 * effort ceiling — no open-ended events lingering in "ongoing" forever.
 */
export const AUTO_CLOSE_NO_END_TIME_HOURS = 12;
