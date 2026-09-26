---
title: Cire invite design selector
tags: [systems, web, api, cire]
related:
  - "[[index]]"
  - "[[cire-invite-builder]]"
  - "[[cire-auth]]"
last-reviewed: 2026-09-26
---
# Invite design selector

A wedding's invite renders as one of several full template packs. The design id
lives on `wedding_invite_customisations.design_id` (0045, default `classic`);
the guest `[slug].astro` SSR fetch resolves it — same link, zero extra
round-trips.

## Pieces

- **Catalog** — `@cire/invite-designs`: `DESIGNS` (`{ id, name, tier }`),
  `DesignId` union, `isDesignId`, `DEFAULT_DESIGN_ID`. Single source of truth
  for api validation, the organiser selector, and the web registry keys.
- **API** — both invite GETs surface `designId`;
  `PUT /api/organiser/weddings/:weddingId/invite/design` (weddingEditor)
  validates against the catalog (unknown → 422) and gates `premium` tiers on
  the `premium_templates` entitlement (403). `inviteService.setDesign` bumps
  `updatedAt` only — never `imagesUpdatedAt` (WT-P-I1).
- **Web** — `cire/invites/src/designs/`: `registry.ts` maps `DesignId` →
  per-design component tree (`classic/` holds the original layout);
  `resolve.ts` (`resolveDesignId`) falls back to classic on unknown ids so a
  guest invite never 500s. Registry imports `.astro`, so vitest tests target
  `resolve.ts` only. Truly shared pieces (LoginSection, RsvpModal,
  DetailsModal, EventCard, PulseAccountLink, invite-theme, invite-images) stay
  in `components/`.
- **Organiser** — Design section in `InviteBuilder`; card per catalog entry,
  lock badge on unentitled premium designs, instant save. **The live previews
  follow the pack** (2026-08-06): `invite/design-layout.ts` names each pack's
  structural signature and `HeroSample`/`SectionSample` render it, so switching
  designs visibly re-shapes the miniature. See [[cire-invite-builder]] §preview.

## The claim and welcome panel

Every pack draws the claim and welcome panel through one component,
[`LoginSection`](../../cire/invites/src/components/LoginSection.tsx). A pack
passes its data and a `layout`; it draws none of the panel's markup.

| `layout` | Pack | Shape | Paints the welcome tone on |
|---|---|---|---|
| `band` (default) | classic | full-bleed section, centred column | the whole section |
| `panel` | gala | 400px bordered card, centred on phones, flush with the page's left gutter from `md` up | the card only |

The two words are the ones the organiser preview uses for the same section
(`welcome` in `design-layout.ts`, see [[cire-invite-builder]]). A layout chooses
class strings only — the frame, the heading size curve, the form width, the
measure, and the greeting's gold: the metal `text-gold` only where the heading
is large text (`band`, 2rem × 0.85 = 27.2px at the smallest heading scale),
`text-gold-ink` elsewhere. Headings follow the organiser's heading typography
in every layout.

Before a claim the panel shows the code entry. After it, the greeting, the
RSVP-by line, and the household's controls in this order:

1. **Pulse account linking** — `PulseAccountLink` inside its own
   `AuthProvider`, both `lazy()`. Their chunks start downloading when a claim
   begins (a typed code or the `?code=` deep link) or, when the restore hint is
   present, at mount beside the session restore — never for a visitor who does
   not submit a code. `tests/components/LoginSection.lazy.test.tsx` fails if an
   import turns static, and it and `LoginSection.warm.test.tsx` pin when the
   download starts. Hidden in host preview, and it renders nothing while
   linking is off (`cire.account-linking`, [[feature-flags]]).
2. **Plus-one prompt** — the slot is reserved;
   `englishstventures/osn#1084` fills it.
3. **Sign-out** — "Not {name}? Sign out". The panel itself revokes
   `cire_session` (`POST /api/claim/signout`, see [[cire-auth]]), drops the
   restore hint, resets its form and clears the inline styles the unlock
   animation left on it. Outside host preview it also ends the OSN sign-in
   the account link uses (`POST /api/auth/signout`, through an on-demand
   import of `@shared/rp-auth`): the household cookie does not cover it, and
   on a shared device the next household would otherwise find it signed in.
   In preview that session is the organiser's portal sign-in, so it stays.
   The pack's `onSignOut` resets only the pack's own state.

The panel also records the restore hint (`noteClaimed`) when a code is
claimed. The pack keeps the claim result, the reveal choreography
(`revealed`, `formRef`, `welcomeRef`), the session restore and the events
section.

When account linking is on, the Pulse box appears once its probe answers, and
it sits above the events. On the code-entry path the probe usually finishes
during the form's fade; on a session restore the box can still push the events
down one request after they appear, until the claim and session responses carry
the link state themselves.

## Adding a design

1. Catalog entry in `@cire/invite-designs` (type error in the web registry
   until step 2 lands).
2. New pack folder `cire/invites/src/designs/<id>/` + registry entry. Each pack's
   `Document.astro` owns its font preloads and islands, so guests never
   download another design's assets. The pack renders `<LoginSection>` with a
   `layout`; a new panel shape is a new row in its `LAYOUTS` table, never
   markup of the pack's own.
3. Row in `cire/host/src/components/invite/design-layout.ts` describing how
   the pack is SHAPED, so the builder's preview stops previewing it as Classic.
   Not optional — `design-layout.test.ts` asserts every catalog id has its own
   entry, so step 1 without this fails the organiser suite.
4. Tier `premium` → gate already enforced; no api change.

## Testing seams

- `AppOptions.inviteDesigns` / `createInviteOrganiserRoutes` 5th param inject
  a test catalog (the launch catalog is all-free, so premium-gate tests add a
  fixture design).
