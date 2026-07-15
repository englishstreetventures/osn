---
"@cire/organiser": patch
---

Portal IA shell (platform Phase 0, PR 3): replace the flat dashboard tab bar
with a module sidebar + a new Overview home.

- **Module shell**: a left `ModuleSidebar` rail (Overview / Schedule / Guests /
  Invite / Settings) plus per-module sub-tabs (Guests: Households/RSVPs; Invite:
  Design/Codes; Settings: Profile/Co-hosts). Keyboard-accessible, `aria-current`
  on the active module, collapses to a horizontal strip on mobile. Existing
  surfaces (import, invite builder, guest table, RSVP view, settings, hosts,
  event locations) rehomed into modules with no loss of behaviour.
- **Routing**: hash scheme is now `#/w/:weddingId/:module/:sub`, parsed +
  serialised with back/forward + deep-link support and a sensible default
  module. Pre-IA `#/weddings/:id/:tab` bookmarks are aliased forward for one
  release (they migrate to the canonical `#/w/…` on first navigation).
- **Overview home**: live countdown to the wedding date, RSVP totals rolled up
  across events, household/event counts, and honest "coming soon" snapshot cards
  for the Phase-1 Checklist + Budget modules (no fabricated data). Getting-started
  becomes the Overview empty-state for a brand-new wedding.
- **P-I3 fetch-lift**: a new weddingId-keyed guests cache (sibling of the events
  cache) dedupes the guest-list fetch across module switches, and the guest table
  reads its event-name map from the shared events cache instead of a second
  `/events` fetch.
- Roles respected throughout: viewers are read-only (import, invite design, and
  event-location write surfaces hidden) and the owner-only invite/codes sub is
  not reachable via a stale deep link.
