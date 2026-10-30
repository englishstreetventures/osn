---
title: Cire invite design selector
tags: [systems, web, api, cire]
related:
  - "[[index]]"
  - "[[cire-invite-builder]]"
  - "[[cire-auth]]"
  - "[[cire-plus-ones]]"
  - "[[cire-entitlements]]"
  - "[[cire-consent]]"
  - "[[browser-tests]]"
  - "[[frontend-patterns]]"
  - "[[cire-rsvp-deadline]]"
  - "[[component-library]]"
last-reviewed: 2026-10-30
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
  validates against the catalog (unknown → 422) and refuses a `premium` design
  (403 `premium_design`) unless the wedding is on the Crimson plan tier or
  holds the one-off `premium_templates` entitlement (`hasPremiumTemplates`,
  given the tier `weddingEditor` already read: no statement on Crimson, the
  entitlement probe alone below it — see [[cire-entitlements]]). `inviteService.setDesign` bumps
  `updatedAt` only — never `imagesUpdatedAt`.
- **Web** — `cire/invites/src/designs/`: `registry.ts` maps `DesignId` →
  per-design component tree (`classic/` holds the original layout);
  `resolve.ts` (`resolveDesignId`) falls back to classic on unknown ids so a
  guest invite never 500s. Registry imports `.astro`, so vitest tests target
  `resolve.ts` only. Truly shared pieces (LoginSection, EventCard, EventSheet
  with its RsvpPanel and DetailsPanel, PulseAccountLink, invite-theme,
  invite-images) stay in `components/`.
- **Organiser** — Design section in `InviteBuilder`; card per catalog entry,
  lock badge on a premium design the wedding cannot use, instant save. The lock
  reads `premium_templates` from the wedding list's `entitlements`, which the
  API fills for a Crimson wedding as well as for one holding the row. **The live previews
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

Before a claim the panel shows the code entry. After it, the greeting (see
[Returning households](#returning-households)), the RSVP-by line, and the
household's controls in this order:

1. **Plus-one prompt** — `PlusOnePrompt`, for a household with a member the
   couple lets bring a guest or a plus-one already named: name, rename or
   remove a guest until the RSVP deadline, read-only after it. The pack passes
   `onPlusOneChange` and applies each change to its claim result; without it
   there is no prompt. Hidden in host preview. The contract is in
   [[cire-plus-ones#On the invite]].
2. **Who are you?** — the household member step, drawn whenever the claim
   payload carries `member` (every guest household, bar an excluded
   wedding's while linking is off — see [[cire-auth]]):
   one button per invited member while none is chosen, then "Answering as
   {name}", with "Not you?" for a household of two or more or a browser
   signed in to musubi. The pack passes `onMemberChange`; without it there is
   no step. Never in host preview.
3. **Pulse account linking** — `PulseAccountLink`, with the OSN auth client's
   core inside its chunk. The panel draws it only when the claim payload's
   `accountLink` offers linking (`cire.account-linking`, [[feature-flags]];
   never in host preview) and a member is chosen, and hands it that state. It
   offers no plus-one's seat, and the API refuses one.
4. **Sign-out** — "Not {name}? Sign out". The panel itself revokes
   `cire_session` (`POST /api/claim/signout`, see [[cire-auth]]), drops the
   restore hint, resets its form and clears the inline styles the unlock
   animation left on it. Outside host preview it also ends the OSN sign-in
   the account link uses (`POST /api/auth/signout`, through an on-demand
   import of `@shared/rp-auth`): the household cookie does not cover it, and
   on a shared device the next household would otherwise find it signed in.
   In preview that session is the organiser's portal sign-in, so it stays.
   The pack's `onSignOut` resets only the pack's own state.

The prompt and the account link are `lazy()`, each in its own `Suspense`. Their chunks start downloading when a claim begins (a typed code
or the `?code=` deep link) or, when the restore hint is present, at mount beside
the session restore — never for a visitor who does not submit a code.
`tests/components/LoginSection.lazy.test.tsx` fails if an import turns static,
and it and `LoginSection.warm.test.tsx` pin when the download starts.

The panel also records the restore hint (`noteClaimed`) when a code is
claimed. The pack keeps the claim result, the reveal choreography
(`revealed`, `formRef`, `welcomeRef`), the session restore and the events
section.

The Pulse box sits above the events, so it must never arrive after them. It
makes no request to draw itself: the claim and restore responses say whether
linking is offered, which seats are linked and whether the browser is signed
in to OSN ([[cire-auth]]), so the box appears in the same pass as the welcome
panel. It does not mount the auth client's Solid `AuthProvider`, whose session
request on mount would hold it back one request. Only its chunk can delay it,
and that download starts as the claim or restore begins.
`tests/components/LoginSection.link-state.test.tsx` renders the real panel with
every request held unanswered and fails if the box waits on one.

## Returning households

A household that has replied before, fully or in part, is greeted as returning.
The copy is the owner's, word for word:

| Where | First visit | Returning |
|---|---|---|
| Panel heading | "Welcome, the {familyName} Family" or "Dear {name}" | "Welcome back to your invite, the {familyName} Family" or "Welcome back to your invite, {name}" |
| Line under the heading | none | "You still have replies to give", while replies are owed |
| Hero title, only when the organiser set none | "You're Invited" | "Welcome back to your invite" |

The organiser's own hero title is never replaced, and neither is their welcome
message, which still follows the heading. The tab `<title>`
(`lib/invite-title.ts`) does not change: the server renders it and never knows
the household.

**Returning means the household replied itself.** The claim payload, from
both the code entry and the session restore, carries one flag for the
household, `householdReplied`: true when any of its reply rows has a
`consent_source` other than `organiser_attested`
([`claim.ts`](../../cire/api/src/services/claim.ts)). So a reply the couple
recorded by phone or on paper does not make a first visit a return. That
covers a household reply, the household's reply for its plus-one, and a host's
status change over a household reply that holds a dietary answer, since that
save keeps the household's consent basis. The flag is a total for the
household, not a field on each row, though with one reply on file, or only a
host's, it does show their source; the household those replies are about is
its only recipient, and no organiser id leaves the API.

The rows keep only their latest writer. When a host saves a full reply over a
household's, or changes the status of a household reply that has no dietary
answer, the row becomes the organiser's and nothing stored says the household
answered it first. A household whose every reply a host has saved over in that
way is greeted as a first visit. The guest site reads only `true`: an API that
does not send the flag, or a value this build does not know, gives the
first-visit greeting and never costs the invite.

**The replies line comes from the rows.**
[`inviteProgress(members, rsvps)`](../../cire/invites/src/components/invite-progress.ts)
counts every row, whoever wrote it, since a host's phone reply does answer the
event:

- `not-started` — no reply on file at all.
- `partial` — an invited member still owes a reply for an event they are
  invited to now.
- `complete` — every invited member has replied to every such event. A
  plus-one is not waited for, as with the tick on each event card
  (`hasHouseholdResponded`), and a "maybe" counts as a reply.

**`LoginSection` decides, once per household.** It takes `householdReplied`
from the claim result the invite opened with — a typed code, the `?code=` link
or a restored session — and keeps it while the same household (by `publicId`)
stays signed in, so a first visit stays one whatever the guest sends during
it. Sign-out clears it. Host preview always gets the first-visit copy. The
replies line, by contrast, is live: it shows while `inviteProgress` reads
`partial`, goes once the last reply is in, and never shows once RSVPs have
closed, when nothing more can be given.

**The hero hears it through a shared signal.** The hero is a separate island,
so the panel publishes its verdict in
[`returning-household.ts`](../../cire/invites/src/components/returning-household.ts),
which both islands import. How the signal stays out of the server render and
out of hydration is in [[frontend-patterns#Sharing state between islands]].
Both surfaces change on page load when the session restores and at the moment
a code is accepted. For a typed code the hero is above the guest's scroll
position by then.

**A hero with no couple title holds room for both titles.**
[`HeroFallbackTitle`](../../cire/invites/src/components/HeroFallbackTitle.tsx)
renders "You're Invited" and "Welcome back to your invite" in one grid cell from
the first paint, and the one not shown is `invisible` and `aria-hidden`, so a
screen reader reaches the painted title only. The cell takes the longer string's
size, so when the restore lands only the painted string changes: no box in the
hero moves. Each pack places the shorter string in that room the way it places
its title block: classic centres it, gala sets it on the cell's foot against the
subtitle. The cost falls on a first visit, whose title-less hero holds the room
the welcome-back title needs:

| Pack | Phone (320 and 390px) | Desktop (1024 and 1440px) |
|---|---|---|
| classic | one line more | none: both titles fit one line |
| gala | one line more | one line more |

*Measured 2026-10-09 — line heights of both strings in real Chromium at the default heading scale, `bun run --cwd cire/invites test:browser` with a probe mounting each pack's header.*

The welcome-back title is a first paint when it appears, so on a hero with no
image it is a new Largest Contentful Paint entry at the moment the session
restores, about twice the first-visit title's area. Rewriting the words of one
painted element instead adds no entry. The guest sees the new words at the same
moment either way; only the metric moves. A hero with an image keeps the image
as its largest paint, and a hero with a couple title, the usual case, draws
neither string.

*Measured 2026-10-09 — `largest-contentful-paint` observer in real Chromium at 1440x900, classic pack, `bun run --cwd cire/invites test:browser` with a probe: entries 37,606 then 75,574 px² across the swap; a single span whose text is rewritten keeps one entry.*

Tests: in `@cire/api`, `tests/services/claim.test.ts` ("householdReplied in the
claim payload"). In `@cire/invites`, `tests/components/invite-progress.test.ts`,
`tests/components/LoginSection.test.tsx` ("returning household"), both packs'
`InvitePage.test.tsx` (a first-time guest's greeting survives their first
reply), `tests/components/returning-household.test.ts` and its `.ssr` twin,
`tests/components/HeroFallbackTitle.test.tsx`, both packs'
`InviteHeader.test.tsx`, and `tests/designs/InviteHeader.ssr.test.tsx` (the
server sends both strings, the welcome-back one hidden). In real Chromium,
`InviteHeader.browser.test.tsx` checks that turning to the welcome-back title
records no layout shift and moves neither the title block nor the subtitle, in
both packs at 320x568 and 1440x900, and that the welcome-back title still stops
above the scroll cue at 320px and at both test widths.

## The hero scroll cue

Every pack's hero fills the screen, so nothing below it shows. A small gold
chevron at the hero's foot,
[`HeroScrollCue`](../../cire/invites/src/components/HeroScrollCue.tsx), tells
the guest the page carries on. A pack renders it as the last child of its hero
`<section>` and passes an `align`:

| `align` | Pack | Sits |
|---|---|---|
| `center` (default) | classic | centred under the centred title |
| `end` | gala | in the inline-end corner on the hero's 1.5rem gutter, opposite the bottom-left title |

- **A hint, not a control.** `aria-hidden` and `pointer-events-none`; a tap
  goes to the hero beneath it.
- **Motion is CSS, and it stops.** `animate-scroll-cue` (`styles/global.css`)
  fades the glyph in 1s after load, drifts it 6px down and back twice, and
  leaves it at rest. Fade and drift take 4.6s together: motion that starts by
  itself and runs past five seconds needs a control to stop it (WCAG 2.2.2),
  so a longer or endless drift is not an option. Both play from the server's
  HTML, before the island hydrates.
- **The first scroll hides it for good.** `createFirstScroll`
  ([`first-scroll.ts`](../../cire/invites/src/components/first-scroll.ts))
  turns true on the first scroll below the top, or at mount on a page the
  browser restored part-way down, and never turns false again. The cue then
  fades out over 500ms and pauses its drift; scrolling back to the top does
  not bring it back. The latch belongs to the mounted hero, so a hero that
  remounts reads the scroll position afresh.
- **Reduced motion needs nothing of its own.** The global clamp lands the
  entry at full opacity at once and runs the drift out to rest, so the cue is
  there and still. The hide still happens, without the fade.
- **It takes the bottom 1.875rem of the hero** (a 1rem offset under a
  0.875rem glyph; the drift moves down, never up). A pack's hero keeps at
  least 2.5rem of bottom padding under its title, so a title long enough to
  grow the hero still stops above the cue. The cue's offset carries no
  `env()` inset: an inset can only widen that padding, never move the cue
  into the title.
- **Nothing of the consent prompt's sits over it.** The first-visit consent
  prompt ([[cire-consent]]) is a modal dialog at every width on the invite's
  pages. It covers the hero, cue and title alike while it waits for an
  answer, and once answered nothing is left over the hero; nothing it does
  moves the cue or shifts the page's layout.

`tests/designs/InviteHeader.browser.test.tsx` measures all of this in both
packs, at phone and desktop width, and the consent prompt over a two-name title
at 320x568, 375x667, 390x844, 844x390 and 1440x900 ([[browser-tests]]).
`tests/designs/InviteHeader.ssr.test.tsx` checks the cue is in each pack's
server HTML, and fails when the catalog gains a pack it does not list.

## Event card states

[`EventCard`](../../cire/invites/src/components/EventCard.tsx) has two
buttons: Event details, always, and the answer button, whose label, fill and
presence follow the household's replies and the RSVP deadline
([[cire-rsvp-deadline]]). Both packs pass the same three facts: `responded`
(every invited member has a reply, `hasHouseholdResponded`), `replied` (at
least one has, `hasAnyHouseholdReply`; plus-ones excluded, any status) and
`rsvpClosed`.

| State | Answer button | Label | Fill and tick | Label ink |
|---|---|---|---|---|
| Open, no complete reply (a part reply included) | shown | Respond | none | `text-on-gold` on gold |
| Every member answered, open or closed | shown | RSVP given | bloom fill, tick | `text-bg` on bloom |
| Closed, part reply | shown | RSVP given | none | `text-on-gold` on gold |
| Closed, no reply | none | — | — | — |

- **The fill and tick mean everyone answered.** A part reply after the
  deadline gets the label, so the guest can look back at it, and not the mark.
  The label follows the mark too, so the host preview's celebration reads
  "RSVP given" with no row written.
- **The label ink follows the fill under it.** Both pairs are held to 4.5:1 by
  `derivePalette`: `--color-on-gold` against `--color-gold`, and
  `--color-bg` against `--color-bloom` ([[cire-invite-builder#Contrast is enforced first, and warned about where it can't be]]).
  During the 500ms sweep the label crosses from one fill to the other; the
  settled states are what the contrast test measures.
- **Hover underlines the label and leaves the gold solid.** A translucent gold
  over the card is a pair no derivation measures, so no gold fill on the
  invite eases its opacity under a label.
- **The "RSVPs closed" badge** sits after the `<h3>` in a shared row
  (`flex-wrap items-baseline`), never inside the heading: `@shared/ui`'s
  `Chip`, outlined in the neutral tone — a hairline and muted ink, no tint, as
  the closed notice wears — a pill in small caps at `text-ui-xs`, held to one
  line. At 320px a long name pushes it onto its own line rather than past the
  card's edge.
- **No inert button.** Closed with no reply, the answer button unmounts; when
  it held focus, focus moves to Event details.

Every gold button on the invite writes its label in `--color-on-gold`: the
hand-written fills (`text-on-gold`, including the hover and focus states that
turn an outline gold) and every `@cire/ui` primary and cta hover, through
`--ui-on-accent: var(--color-on-gold)` in `src/styles/global.css`. On
evergreen, jewel and fog that is the page colour, as it always was; on chapel
it is a near-black and on garden a near-white, because neither the cream page
nor the ink reaches 4.5:1 on their mid-tone gold.

Tests: `tests/components/EventCard.test.tsx` (each state, the badge's place,
the focus rescue), `EventCard.actions.browser.test.tsx` (the labels and badge
at 320px) and `EventCard.contrast.browser.test.tsx` (every label on its fill,
on every preset, at rest and on hover).

## The event sheet

Each event card has two buttons, Event details and the answer button
([[#Event card states]]). Both open one dialog, [`EventSheet`](../../cire/invites/src/components/EventSheet.tsx),
holding two panels: [`DetailsPanel`](../../cire/invites/src/components/DetailsPanel.tsx)
(the key facts, then the occasion — [[#The details panel]]) and
[`RsvpPanel`](../../cire/invites/src/components/RsvpPanel.tsx) (the reply
form). Every pack mounts it the same way, from one `sheet` signal holding the
event and the panel to open on.

- **It opens on the panel whose button was pressed**, every time. The page
  clears the sheet on every close, so nothing from an earlier visit carries
  over. That is the owner's choice over remembering the last panel per event.
- **A bar at the top stays put while the panel scrolls under it**: the
  sheet's title, then the badge, then the close button
  ([`AnimatedModal`](../../cire/invites/src/components/AnimatedModal.tsx)'s
  `toolbar`). The close is `@cire/ui`'s `Button` `round` at `lg`: a 44px disc
  on the opaque surface, so the panel scrolling under it stays hidden, with no
  edge, its × on the `lg` text step in muted ink that brightens under the
  pointer. It is the scrollport's first child and `sticky` at its top, so
  the panel passes beneath it rather than past it. It is no part of either
  panel: a swipe never moves it, and a touch on it starts none.
  - **Its look.** Full-bleed across the sheet and at least 3.75rem tall
    (`min-h-15`, with `py-2` keeping a wrapped title's lines off its edges),
    with the title on the content's 24px edge, the cross 8px in from the
    sheet's corner, the badge and the cross centred on the bar's height, a
    hairline (`border-border/60`) under it, and 1.25rem between it and the
    content at rest. Frosted: 75% of the sheet's own surface
    (`bg-surface/75`) over a 12px blur (`backdrop-blur-md`) of what passes
    under it, so the content shows through as a soft shadow moving under the
    title. The badge and the cross keep opaque surface fills of their own: on
    an 80% frost the badge's gold words (`--color-gold-ink`) measure
    3.34–4.20:1 over black or white content, depending on the scheme, and
    they need a 92% fill to hold 4.5:1, which leaves no glass to see through.
    On the 75% frost the title holds 4.5:1, and the cross 3:1, over pure
    black and pure white on every built-in scheme.

    *Measured 2026-10-21 — a temporary probe in Chromium 1194 compositing each preset's `--color-surface` at 80–100% over #000 and #fff and reading `--color-gold-ink` against it; the 75% figures are `EventSheet.browser.test.tsx` "frosts the bar"*
  - **The title** is the event's name in the display face (`text-ui-lg`,
    and one step down, `text-ui-md`, on a phone narrower than 380px; light
    italic), whole: it wraps onto as many lines as it needs in the room the
    badge and the cross leave it, and is never cut short or clamped. The bar
    grows with it. It breaks between words, and inside a word only when the
    word is longer than a whole line (`wrap-break-word`), hyphenated there
    where the engine has the page's language (`hyphens-auto`; the invite's
    `<html>` is `lang="en"`). The smaller step is what keeps a word and the
    comma after it on one line where the title has least room: at `text-ui-lg`
    on a 320px phone beside "View your RSVP →", "Reception," does not fit a
    line and its comma is left alone on the next. On a 320px phone "Sangeet
    and Reception, Thiruvananthapuram" takes four lines beside any of the
    badge's labels, only "Thiruvananthapuram" breaking inside itself; "Mehndi"
    takes one. A word longer than a whole line still breaks where the line
    ends, and with no hyphenation dictionary (Chromium on Linux, where these
    are measured) that can be just before a comma. The badge and the cross
    never shrink.

    *Measured 2026-10-21 — `EventSheet.browser.test.tsx` "shows the whole of …" screenshots at 320×568 and 390×844, and the same test with `text-ui-lg` at every width, Chromium 1194*
  - **Nothing hides under it.** The bar takes its own height in flow, so the
    content starts below it, and the scrollport's `scroll-padding-top` is that
    same height, whatever the title's lines make it: a `ResizeObserver` on the
    bar writes its border-box height to `--sheet-bar` on the scrollport
    (`scroll-pt-[var(--sheet-bar,3.75rem)]`, the floor until the first
    observation). So a control reached by Shift+Tab is never parked under it.
    The swipe's arriving panel is held from the rail's `offsetTop` down, so
    it follows the bar's height without a second measurement.
  - **Unverified on WebKit** — how the frost clips at the sheet's rounded top
    corners, and everything else engine-specific about it; this repository's
    browser tier is Chromium only.
- **A badge in the bar leads to the other panel** without closing the
  dialog: "Give RSVP →" on the details, "← See details" on the form ("View
  your RSVP →" on the details past the deadline, for a household with a reply
  on file), each arrow pointing the way the guest can also swipe. It is one
  `Button` of `@cire/ui`'s `chip` variant ([[component-library]], cire's
  `Button`): a pill matching the round close button (the `pill` step,
  `rounded-ui-pill`, whatever `control` is), an accent hairline, the opaque
  surface fill, a sentence-case label at `text-ui-xs` and medium weight in
  `--color-gold-ink`, 44px tall (`min-h-11`).
  - **Two labels in one button.** Both labels sit stacked in one grid cell,
    so the badge is always as wide as the wider of them ("← See details" on
    an open invite, "View your RSVP →" past the deadline) and never changes
    width, at rest or mid-swipe. The cell is the badge's window, clipped
    (`overflow-clip`) inside the button's padding, pill and hairline. The
    label for the panel on screen fills it; the other waits just outside it,
    transparent and `aria-hidden`, so the button's name is only ever "Give
    RSVP", "See details" or "View your RSVP".
  - **Its words follow a swipe, like a ticker.** One custom property on the
    button, `--badge-progress`, is 0 on the details and 1 on the form. Each
    label is the window's full width; the details' moves `p × 100%` of it
    out by the start and fades to `opacity: calc(1 - p)`, while the form's
    comes in from `100%` by the end at `opacity: p` — the way the panels go.
    The two stay exactly one width apart, so mid-swipe each shows in part,
    side by side, and never over the other. The property is written only through
    `setBadgeProgress`: as the badge is built, from the panel on screen (so a
    sheet opened on the form shows its words with no fade); on every switch;
    and by the swipe and its spring, which write the share of the panels'
    width they have covered on every frame, held between 0 and 1 so a pull
    past either end moves the panels and not the words. Then nothing eases
    (`data-dragging` turns the transition off); after a press the words ease
    on `transition-badge-settle`, the panels' own `--dur-base` and
    `--ease-out`, as inline
    `transform`s so one transition list covers the opacity and the slide.
    Under reduced motion the global clamp makes it instant.
  - **Its states.** Shown on the form always, and on the details while the
    form can be reached. Disabled (40% opacity) on the form while a save is
    in flight and while the sheet closes itself on a saved reply. A tap on it
    while a slide or swipe is still running is ignored: it sits in the same
    place on both panels, so the second tap of a double tap would otherwise go
    straight back; a key press always goes through. No hover state beyond the
    variant's hairline: the invite is read on a phone.
- **One height.** The sheet keeps one height whichever panel shows: 70% of a
  phone's screen (`70dvh`), and from `md` 85% of the window (`85vh`, the
  presentation's own cap) up to 640px (`AnimatedModal`). Its edge does not move on a press of the
  badge or a swipe, in either direction, nor when the form grows as the guest answers: a
  panel taller than the sheet scrolls inside it. Nothing is measured, so
  neither panel loads anything for the other's sake. A sparse event leaves
  empty sheet under its details; the form fills the sheet with its action bar
  on the bottom edge however short it is, and a form a swipe draws in is drawn
  at the height it will have at rest — from where the panels start under the
  bar to the sheet's bottom edge — so its bar does not drop when it lands. The
  scrollport has no bottom padding for either panel (the action bar is
  `sticky`, and a sticky box keeps inside its scrollport's padding); the
  details carry that padding on their own wrapper. The values are the owner's
  request for less empty sheet under a sparse event, settled by rendering
  (65, 70 and 75dvh; 600, 640 and 680px tried). At 390×844 the sheet is 591px,
  and a sparse event leaves 394px of it empty under its date; a household of
  one answering "Attending" needs 330px, so its whole reply shows, as it does
  at 375×667. At 1280×800 the sheet is 640px, and the same reply needs 637px,
  so every diet and allergy choice, "Other" included, shows above its bar.
  The bar is clear of every safe area: on a phone the sheet's top is at 30% of
  the screen (× at 262px on 390×844, 179px on 320×568), and in landscape,
  which takes the `md` rule, it sits 182px in from each side.

  *Measured 2026-10-21 — temporary probe tests in Chromium 1194 at 390×844, 375×667, 320×568 and 1280×800: the sheet's and the ×'s rects, the details' `dl` bottom to the scrollport's bottom for a sparse event, and the form's needed height as the scrollport's `scrollHeight` with the dialog forced to 100px; the 182px is from the candidate-height probe at 844×390*
- **A swipe does the same.** On a touch screen the panel on screen follows a
  sideways drag toward the other panel — the details sit on the start side,
  the form on the end side — with the other panel drawn beside it, `inert`
  until it lands. Let go past three tenths of the width, or after a flick,
  and it carries on; otherwise it springs back. Either way the panels ride a
  critically damped spring (`SETTLE_SPRING`, 0.3s response, through
  `motion`) that starts at the finger's speed, so a flick carries on and a
  slow release does not jump; under reduced motion they land at once. Past
  either end — back past where the drag began, or beyond the form's rest —
  the panels follow the finger on iOS's rubber band, `c·x·d / (d + c·x)`
  with `c = 0.55`, giving less the further it goes. A pull toward the side
  with no panel moves the panel on screen on the same band and springs it
  back; it mounts nothing. A touch on a settling swipe catches it: the panels
  stop under the finger and follow it from there, and a catch that is only a
  tap, a held finger or a scroll lets the settle go on to where it was going,
  with that tap's click swallowed so it presses nothing on the moving panel.
  The thresholds and the band are pure functions in
  [`sheet-swipe.ts`](../../cire/invites/src/components/sheet-swipe.ts).
  The wrapper is `touch-action: pan-y pinch-zoom`, so vertical scroll and
  zoom stay the browser's. A mouse drag, a drag that starts in a text field,
  and a drag on a box that scrolls sideways of its own (the dietary chips, the
  moodboard) never move the panel, and nor does a drag on the bar, which is
  outside the panels. The same rule gates the badge and the swipe: from the
  details while RSVPs are open or a reply is on file, from the form while it
  is not busy. Once a drag begins it clears any text selection a
  long press started, and the panels are `select-none` until it settles; a
  still long press, before the drag, can still select the address to copy it.
- **Nothing typed is lost.** A panel mounts the first time it shows and stays
  mounted, hidden, until the sheet closes, so the form keeps its answers
  across a look at the details. A guest who only answers never mounts the
  details, so the consent-gated map and moodboard ([[cire-consent]]) load only
  for a guest who asks for them — by the badge, or by starting a swipe
  toward them.
- **One title per panel, in the bar; none in the panels.** The bar holds two
  `<h2>` titles, the details' and the form's, and shows the one for the panel
  on screen. Each reads as the event's name and says its panel's name to
  assistive technology only — "Details, Mehndi", "Respond, Mehndi" ("Your
  RSVP, Mehndi" past the deadline) — and the dialog takes its name from the
  one shown. The panels carry no title or eyebrow of their own: the badge
  points to the other one, and a panel starts with its first content (the
  details with their date, the form with its first notice or guest).
- **Focus moves to the new panel's title.** Two titles rather than one
  relabelled, because focus sent to the element already holding it is no
  move, and nothing would be announced. After a tap, a click or a swipe that
  focus is quiet: nobody reached the title by keyboard, so it is marked
  `data-quiet-focus` (`quiet-focus.ts`) and `global.css` draws no ring on it,
  where an engine that matches `:focus-visible` on a script's focus after a
  touch (iOS Safari) would otherwise show the title as selected. A key press
  on the badge keeps the ring, drawn on the title in the bar. Closing from
  either panel hands focus back to the card button that opened the sheet; the
  platform's `<dialog>` does that.
- **The scroll goes to the top** of the new panel, so its first content is in
  view under the bar. The form's scroll position is not kept across a visit
  to the details; its answers are.
- **No tap flash.** The sheet sets `-webkit-tap-highlight-color: transparent`:
  iOS flashes grey over a tapped element that is focusable or takes pointer
  events, and the scrollport (focusable, for its keyboard) and the panels'
  swipe rail are each the size of the sheet.
- **The page behind stays still.** The lock is the root's `overflow: hidden`,
  with `overscroll-behavior: none` beside it so a drag that reaches the end of
  the sheet's own scroll neither chains into the invite nor rubber-bands it;
  both are put back on close, with the scrollbar gutter that stands in for a
  classic scrollbar while it holds (`AnimatedModal`).
  *Unverified on iOS* — whether a touch drag on WebKit can still move the
  page behind; the browser tier is Chromium only, and the footer's version
  ([[cire-invite-builder#The footer's version]]) is how a report from a phone
  names its build.
- **Motion.** The arriving panel fades in while sliding the last 1.5rem from
  its own side — the details from the start, the form from the end, the order
  of the card's buttons — over `--dur-base` on `--ease-out` (200ms on touch,
  150ms with a fine pointer; `animate-panel-from-*` in
  `src/styles/global.css`). The panel the sheet opens on does not slide; it
  arrives with the sheet, and one that arrived by a swipe does not slide
  again: it springs from where the finger let go to rest, at the finger's
  speed, before the switch. The badge's words move in step with both: with
  the panels through a swipe and its spring, and on the same `--dur-base`
  after a press. Until the slide ends the arriving panel takes no
  pointer input, so the second tap of a double tap cannot land on a control it
  has not shown yet, and the panels' wrapper clips sideways overflow, which
  the sliding form's full-bleed action bar would otherwise cause. Outside a
  switch nothing is clipped. Under reduced motion the global clamp makes the
  switch instant.
- **The answer pair**, Attending and Not attending, is `Button` `choice` at
  `md` with the 44px floor (`min-h-11`), as `aria-pressed` toggles. The chosen
  answer wears the accent edge, the readable gold and a 2px ring at 60% of the
  gold, and no fill; an unchosen one under the pointer goes halfway, its edge
  and ink a mix of rest and chosen with a 1px ring at 30%, on `--dur-base`.
  While a reply saves the pair is locked with `aria-disabled`: it keeps its
  look, so the answer just given stays legible, and takes no click. The pair
  sits side by side while its own box is 16rem or wider and stacks below
  that, a container query on the pair's own wrapper measured against the
  guest site's Lato, so "Not attending" never runs out of a 320px screen
  (`tests/components/RsvpPanel.browser.test.tsx`).
- **Past the RSVP deadline** the form is read-only: each member's answer on
  file is written out in place of the answer pair, and one line about stored
  dietary data takes the consent boxes' place ([[cire-rsvp-deadline]]). The
  details panel's closed notice says "RSVPs closed on …" and the household's
  next step — to reply, or to change a reply, contact the couple directly — in
  a live region present from the start, so a deadline that passes with the
  sheet open is announced. A household with a reply on
  file keeps its way into the form, the badge relabelled "View your RSVP →"
  in the same element, so focus on it stays; one with none loses the badge
  and the swipe on the details, and if focus was on the badge when it went,
  focus moves to the details' title ([[cire-rsvp-deadline]]).
- **The card's mark waits for the sheet.** `covered` holds the answer
  button's confirmation back while the sheet is open on either panel.

Tests: `tests/components/EventSheet.test.tsx` (what mounts, hides, names and
takes focus; the bar's two titles, one per panel; the badge's names, its
place in the bar ahead of the panels, its double-tap guard and its states;
the deadline), `AnimatedModal.test.tsx` (the bar's order — title, action,
cross — as the scrollport's first child), `sheet-swipe.test.ts` (the swipe's
thresholds), `EventSheet.browser.test.tsx` (in Chromium, see
[[browser-tests]]; the swipes are real touches sent through `cdp()`; the
bar unmoved while the details scroll 200px under it at 390×844 and 320×568,
frosted with its words held over black and white content on every scheme;
the whole event name, unclipped, beside each of the badge's three labels at
390×844 and 320×568 for a short name and a long one, with the badge and the
cross inside the bar and the scroll padding at the bar's height; a long name
wrapping at 320px; Shift+Tab up a form under a four-line bar never parking a
control under it at any step; the sheet's height read on every frame of a journey by
badge and by swipe, for a sparse event and a full one; a full event's panels
scrolled to their ends; the badge's words mid-drag at 20px and 60px holds,
each moved and faded by the finger's share, side by side in its clipped
window, back on a cancel, landed on a commit, eased on a press and still on
open, and its width the same throughout; no comma left alone on a line of
the title, and the title a type step down below 380px; the quiet focus after a swipe or a click
and the ring after a key press; with screenshots of each panel, of the bar
at both sizes for each label and name and scrolled on each scheme, and of the
badge mid-swipe under `__screenshots__/`), `AnimatedModal.browser.test.tsx`
(the root lock and its `overscroll-behavior`; first focus on the scrollport
with and without a toolbar), the `cire-rsvp` end-to-end flow (a phone-sized
round trip by swipe and badge, a drag on the bar and the backdrop that leaves
the page still, a sideways flick on the bar's title that leaves the details
on screen, the details scrolled 200px under the bar, the badge's words
part-way under a held swipe, with screenshots of both panels, the scrolled
bar and the mid-swipe), both packs' `InvitePage.test.tsx` (which panel each
button opens, on every open) and `InvitePage.browser.test.tsx` (the round
trip in each pack, ending with focus on Event details).

### The details panel

It leads with the plan — what a guest opens it for — and keeps the occasion
for after.

| Part | What it holds | Shown when |
|---|---|---|
| Header | The closed notice (the closed treatment of `RsvpDeadlineNotice`: a hairline box, muted ink) inside an always-mounted `role="status"` region, which takes no room while it is empty. The title and the way to the form are the sheet's bar's, not the panel's | Always; the notice once RSVPs close |
| When | The day; the time range, naming both days when the event ends on a later day in its own zone ("Fri 6:00 pm – Sun 11:00 am"); the zone spelt out ("AEDT (Sydney time)"); "Your time: …" when the guest's own clock reads differently; Add to calendar | The start parses |
| Where | The venue's name over its address (with no name, the address alone); a compact map — the consented Google embed, or a card drawn from the palette tokens; "Open in maps", a menu of Google Maps, Apple Maps and Waze, or a plain link when the organiser's own is the only place to go | Something can open a map (`hasVenue`: an address, a venue name or a maps link) |
| Who's invited | "Invited: Alex and Sam" | Some member the couple invited is not invited to this event (`invitedNames`; plus-ones are named, never decide it) |
| Guest policy | The presets in words on one line ("Adults only · Plus-ones by invitation"), the note under them in muted ink. The last of the facts, so the date and the venue keep a phone's first screen | A preset this build knows or a note (`hasGuestPolicy`, then `guestPolicyLines`); "Plus-ones welcome" only for a household with a member invited to this event whose `plusOneAllowed` is true, which the claim also sends `welcome` to alone |
| Run of show | Under its own hairline: the items in time order from the event's start, each a time on a 12-hour clock in a 4.75rem column ("4:00 pm") and its name; "Times are AEDT (Sydney time)." under them when the guest's own clock reads differently | Any item has a 24-hour time and a label (`hasRunOfShow`, then `runOfShowLines`) |
| Occasion | About, Dress Code, Inspiration, under one hairline, with no hairline between them | Any of the three has content |
| Getting there | Under its own hairline, last: the organiser's notes, line breaks kept | The notes have text |

The facts are a `<dl>`: each row's term ("When", "Where", "Who's invited",
"Guest policy") is for assistive technology, and a glyph in the metal says it
on screen. Each labelled block's gold label (Run of show, About, Dress Code,
Inspiration, Getting there) is an `<h3>`, one level under the bar's `<h2>`
title. The guest's own zone is read after mount, so the first render matches
a server render wherever the server ran.

- **The run of show reads from the start.** The organiser keeps the items in
  their own order; the sheet sorts them by their distance from the event's
  start on its own clock, so a time earlier than the start comes last, as after
  midnight — a reception's "12:30 am Carriages". Items at the same time keep
  the organiser's order. The start's clock is read with `Intl` in the event's
  zone, and from the stored value when the zone does not resolve, so a bad zone
  never throws during a server render. The 12-hour clock is written out rather
  than formatted, so a server render and the browser always agree. An item on
  the second day of a multi-day event cannot be said; the times carry no date.
- **The guest policy never contradicts the household.** The presets are
  wording; who may bring a plus-one is each member's own permission
  ([[cire-plus-ones]]). So the organiser's own Preview invite, a household with
  no allowance, does not show "Plus-ones welcome" either. The claim payload
  carries the preset as stored; the rule is the guest site's
  (`guestPolicyLines`).
- **A malformed value costs its own block.** The claim guard proves the notes
  and the presets as strings when present; the run of show is read through
  `runOfShowLines`, which keeps only well-formed items, and an unknown preset
  reads as not stated, so a newer or broken API never sends a household back to
  the code form through them.

- **The venue reads as the day does.** With a name, the Where row's first line
  is the name, set as the When row's day is (`text-ui-md`, body ink, light,
  two lines at most), and the address follows as the time range does: muted
  ink at the regular weight. An address that already starts with the name, as
  whole words (`addressRepeatsName` in `event-details.ts`), is shown alone as
  the headline, as it is when there is no name, so the row never says the name
  twice. The map and "Open in maps" search for the address, or for the name
  when there is none (`venueQuery`); the embed's title names the venue by its
  name, else its address. Calendar entries put the name before the address
  ("The Glasshouse, 124 Sample Avenue"), leaving it off by the same rule
  (`venueLocation`).
- **Open in maps offers the guest's own map app**
  (`mapsDestinations` in `maps-destinations.ts`, which only the event sheet
  loads): Google Maps, Apple Maps and Waze, in that order, each searching for
  the address (else the name), escaped once for all three. The organiser's
  own http(s) link takes the place of the app whose link it is, read from its
  host — a closed list of Google's domains (`google.com` and the country
  domains it names, such as `google.co.uk`, `google.com.au` and `google.de`,
  each bare or under `www.` or `maps.`) under `/maps` or on `maps.`, plus
  `maps.app.goo.gl`, `goo.gl/maps/…` and `g.page`; `maps.apple.com` and
  `maps.apple`; `waze.com` — and a link to any other site leads the list as
  "Venue map". The Google list is closed rather than a pattern because under
  a country whose registry runs no `co.` or `com.` (`.de`), `google.com.de`
  is anyone's to register. A host it does not recognise costs the link its
  label, not its place. With more than one destination it is a link
  menu (see the link menus below); with one — the
  organiser's link and nothing to search for — a plain link marked ↗. The row
  shows exactly when `resolveMapsUrl` has somewhere to go, which is exactly
  when this list is not empty.
- **About is the organiser's description**, line breaks kept. The event card
  shows its first three lines and, on its venue line, the venue's name when
  there is one (the address otherwise); the whole of both is in the sheet.
  Organiser text here (the card's venue line and description, About, the
  dress-code text, the Where row, the run of show's names, the policy note and
  Getting there) is `wrap-anywhere`: a pasted link or a venue named in one
  token has nowhere else to break, and would otherwise widen the card past the
  screen or clip at the sheet's edge.
- **Text actions, not boxes.** Add to calendar, Open in maps and Open on
  Pinterest are `@cire/ui`'s `touchLink` variant at a 44px target, so the
  sheet's switch stays the one way between the panels drawn as a control. `touchLink`
  carries its underline at rest: the invite is read on a phone, where an
  underline that waits for hover never shows, and colour alone does not mark
  words as something to press (WCAG 1.4.1). Open in maps is named by its own words, with no
  `aria-label` over them.
- **The link menus** — Add to calendar's, and Open in maps' when there is more
  than one map to offer — are one component,
  [`LinkMenu`](../../cire/invites/src/components/LinkMenu.tsx). Each keeps
  `role="menu"` and the menu-button keys: Enter, Space or ArrowDown on the
  trigger open it on the first item, ArrowUp on the last; the arrows wrap,
  Home and End jump, Escape closes it onto the trigger, and Tab closes it and
  moves on. A tap or click opens it on the menu itself, quietly (no ring), not
  on an item: an item filled gold the moment the menu opens reads as already
  chosen. The arrows reach the items from there. Choosing an item closes it
  onto the trigger too, as the item goes with the menu and focus left on it
  would fall outside the sheet. Every key it takes cancels its default, so
  nothing scrolls the sheet under it. It opens under its trigger's left edge,
  upward only when there is no room below, and never past the viewport's 8px
  gutter, in the top layer over the sheet. Its items are 44px rows in the
  muted ink, filled gold with the on-gold label under the pointer, under
  keyboard focus (`focus-visible`) and while a finger presses one (`active`)
  — never for a pointer's focus alone.
- **Swatches** are a list in a grid of 3.75rem columns (five across at
  390px), each name as the organiser wrote it, under a circle hidden from
  assistive technology. The circle's ring is `--color-border-strong`, held to
  3:1 on every scheme ([[cire-invite-builder#Contrast is enforced first, and warned about where it can't be]]),
  so a dark colour on a dark invite keeps an edge.
- **Inspiration** is one block: where the board is, "Open on Pinterest", and
  — while Pinterest moodboards are off and the link is a board that can be
  embedded — "Show it here", which says what it switches on before it is
  pressed ([[cire-consent]]). Pressing it leaves focus on the moodboard's own
  wrapper, inside the sheet, as the block and its button give way to the
  board. While the board is on, "Stop showing moodboards" sits under it and
  says the page reloads, and it leaves focus on the same wrapper when the
  reload does not come (a cookie write it could not confirm). It ignores a
  press for the half second after "Show it here", because near the foot of the
  sheet the scroll shifts as the block gives way and the button can arrive
  under the finger that just pressed.

Tests: `tests/components/DetailsPanel.test.tsx` (which rows and sections
render, the words, the notice, and no run of show, policy or getting there
when none has content), `event-details.test.ts` and
`invite-emptiness.test.ts` (the helpers, one case per failure mode: the run
of show's order across midnight, the stored-clock fallback and malformed
items; the policy's plus-one rule), `utils.test.ts` (the claim guard),
`calendar.test.ts` (the venue in the Google link), `MapPreview.test.tsx` (the
maps menu's items, the organiser's link in its app's place, the plain link
when it is alone, the refused `javascript:` link), `AddToCalendar.test.tsx`
(the menu opened by a key on its first item, by a pointer on the menu), and
`DetailsPanel.browser.test.tsx` (on every preset: each key fact at 4.5:1, the
venue's name and its muted address, the policy, the run of show's times and
names and Getting there included, and each swatch ring at 3:1 on the
sheet; at 390px the date, the venue's name and its address on the first
screen, every control 44px tall, every text action underlined at rest, and a
link in the description, a run-of-show name, the policy note and Getting
there kept inside the sheet; the address under a name at
the time line's weight and colour; the calendar menu's keys, its focus return
and its placement, opened by a click on the menu with no item filled; the maps
menu over the sheet, its item answering a hit test, with a screenshot at 390px; focus after "Show it here" and the switch-off's double-tap guard),
and `EventCard.actions.browser.test.tsx` (the answer button inside the card
beside a link in the description and a one-word venue name). The
`cire-event-details` end-to-end flow sets a venue name, a description, a run
of show, getting-there notes and a guest policy in the organiser's drawer and
reads them in the preview's sheet — the blocks in order, the run of show in
time order, no "Plus-ones welcome" for the organiser's own household — its
claim response and its `.ics` file, and in the sheet of a household allowed a
plus-one, which is told plus-ones are welcome.

## Corners, labels and motion

Every design paints the corner roles of the four cire apps, at the same values
as the portals (`cire/host/DESIGN.md` §4);
`cire/vendor/tests/styles/tokens.test.ts` reads this site's
`src/styles/global.css` and fails if a role, a step or the motion ladder
differs. On the guest site each corner paints:

| Corner | Paints |
|---|---|
| pill, `rounded-ui-control` | Respond, the RSVP sheet's Attending / Not attending pair and Save, every `@cire/ui` `Button` action, the gift amount choices, and the focus ring of a hand-written text link, to match the ring `Button`'s borderless variants draw |
| 14px, `rounded-ui-field` | every input and textarea (the code field, email, a plus-one's name, "Anything else", the gift fields); a framed picture and its crop box (the event photo, both packs' story photo, the map embed and drawn map card, the gift teaser and fund thumbnails); a gift fund row; the answer on file past the deadline, a value box standing where the answer pair would be |
| 16px, `rounded-ui-lg` | the event card, gala's code-entry card, both packs' hero title panel, the gift money panel and the gift item card, whose `overflow-hidden` clips its picture to the corner |
| 1.75rem, `rounded-t-ui-sheet` | the top corners of a bottom sheet (`Modal presentation="sheet"`) |
| 10px, `rounded-md` | the link menu |
| 6px, `rounded-sm` | notices — closed, preview mode, the RSVP deadline, "You reserved…", the gift page's payment, signed-out and preview notices, a legal page's draft banner and owner note — and the blocked-content placeholders (`MoodboardBlock`, `ConsentPlaceholder`); the link menu's rows; a box nested in a modal (the RSVP sheet's member fieldsets, the consent sheet's switch rows) or in a card (the household boxes inside gala's card); the gift page's "Send gifts to" address box |
| 2px, `--radius-hair` | nothing on the guest site: a legal page's inline placeholder (`.placeholder`) draws no highlight, so no box to round |
| round, `rounded-full` | the "RSVPs closed" badge (`Chip`); the sheet's close cross (`Button` `round`, the `pill` step), the dress-code colour circles, avatars, the gift radio marks, the spinner, the map pin's shadow |

- **Fields keep this site's own heights.** The portals' one form-field height
  (34px, `cire/host/DESIGN.md` §4) does not reach the guest site, which is not a
  portal (owner, 2026-10-29): each field stays at the height its padding gives
  it, so a guest's tap target does not shrink.
- **An unchecked checkbox or radio sits on its surface**: no fill, a 1px
  `--ui-hairline-strong` edge, the native box's 13px and 2px corner (a radio
  round), drawn in `global.css`'s base layer. A ticked one is the browser's own,
  blue with a white tick: no box carries an `accent-*` class, and
  `tests/styles/checkbox-accent.test.ts` fails on one (owner, 2026-10-29;
  `cire/host/DESIGN.md` §4, Checkboxes and radios).
- **The household's boxes take their corner from the layout.** The plus-one
  prompt, the email box and the account link draw no corner of their own; the
  `box` field of `LoginSection`'s `LAYOUTS` sets it. On classic's band they sit
  on the page and take the card corner, `rounded-ui-lg`. Inside gala's 16px
  card they take `rounded-sm`: a box inside another takes the outer corner less
  the padding between them, to the nearest step.
- **No gold tint under gold words.** `derivePalette` walks the readable gold
  (`--color-gold-ink`) to 4.5:1 against each ground alone, so a tint between
  the two is a backdrop nothing measures — the rule [[cire-rsvp-deadline]]
  already sets for the deadline notice. Every gold note a guest sees — the
  welcome's and the RSVP sheet's preview notes, and the gift page's payment,
  signed-out and preview notes and "You reserved…" — is `Notice`'s `accent`
  note at `sm` with `fill="none"`: its 40% gold rule and readable gold on the
  ground beneath. The household's boxes keep their 30% gold rule and draw no
  fill, and the account's initial sits in its round slot with no disc. A
  chosen answer in the RSVP sheet keeps its gold border and gold label; a
  chosen gift amount keeps those and its tick, a chosen fund row its gold
  border and filled radio mark. A legal page's placeholder is gold mono text
  with no highlight. `tests/components/notice-contrast.browser.test.tsx` holds
  each at 4.5:1 in every scheme on every ground it can sit on, and fails any
  fill between a gold word and its site's own box.
- **The owner note** on a legal page is square on its ruled side
  (`0 var(--radius-sm) var(--radius-sm) 0`), so the 2px rule stays straight.
- **The closing band image is square.** It runs edge to edge below 1536px and
  has no frame.

**Labels.** A button's or a link's label is sentence case in the source —
"Event details", "Respond", "RSVP given", "Open invitation", "Attending",
"Save choices", "See the gift list", "Back to the invitation" — and shows as
written, at normal tracking, with a medium weight on a boxed label. Lato loads
300, 400 and 700 only, so the medium weight draws the 400 face. Proper names
keep their capitals: "Google Calendar", "Apple Maps", "musubi", and the
footer's "Privacy Notice" and "Privacy Choices", the names of the legal
document and of the control the guest privacy notice quotes by name
(`cire/ui/src/guest-privacy-notice.astro`). Small caps stay on what is not a
label: eyebrows, the details panel's section heads, field labels, the "RSVPs
closed" badge, the account link's status word, the
gift list's header row and the code field's typed value. Headings keep each
design's own case. The eyebrows and the details panel's section heads are
`@cire/ui`'s `Eyebrow` (an `.astro` page's `eyebrowClass`), in the couple's own
readable gold and at their body weight, since the palette sits on `<html>`.
The FAQ's questions are its `Disclosure` in the rule tone: each entry draws the
rule under it, the trailing `+` turns into × at the question's own size, and
classic draws one rule above the first.

**Motion.** The site carries the portals' ladder: `--dur-fast`, `--dur-base`
and `--dur-slow`, shorter under `pointer: fine`, and the house easings, so
Tailwind's `ease-out` class reads the house curve. A hover, a focus or a press
runs on `--dur-fast` and `--ease-out`, except the answer pair (`Button`
`choice`), whose colours and ring move on `--dur-base`; the sheet's panel
swap, the badge's words after a press, Respond's label ink following the bloom
fill and the FAQ body's arrival run on `--dur-base`. Choreography longer than `--dur-slow` keeps
its own timing:

- the bloom fill, 500ms (`SWEEP_DURATION_MS` in `rsvp-responded.ts`);
- the tick, 340ms after 180ms (`TICK_DURATION_MS`, `TICK_DELAY_MS`);
- the hero scroll cue's fade, delay and drift, and its 500ms fade on the first
  scroll;
- the hero backdrop's 700ms fade-in and the closing band's 500ms width;
- each pack's unlock reveal (`UnlockReveal.motion.ts`, Motion One).

## Edges in mobile Safari

Safari colours the status bar and the bottom toolbar from what is painted
behind them. Each invite shell draws two fixed strips, one at each viewport
edge, in the colour of the page there (issue #1700).

- **Shells.** `designs/classic/Document.astro` and `designs/gala/Document.astro`
  set `viewport-fit=cover` and `body.invite-page`, and render the two
  `.edge-strip` divs. Without cover, iOS reports the safe-area insets as 0.
  The gift-registry, not-found and legal shells do not change.
- **Probe.** An inline script in `<head>` (`EDGE_BOOT_SCRIPT` in
  `components/edge-boot.ts`) measures each inset and sets `has-safe-top` or
  `has-safe-bottom` on `<html>` before first paint. A strip shows only on an
  edge that has an inset, so desktop, Android and Chromium get none.
- **Colours.** The server writes `--edge-top-bg`, `--edge-bottom-bg` and the
  `theme-color` meta from the palette. The top edge is the hero's start colour
  and the bottom edge is the hero's end colour while the hero covers the bottom
  strip zone; otherwise both are the page background. `startEdgeColours` keeps
  them current on scroll, resize, orientation change and `cire:palette`.
- **Stacking.** The strip is `Z_CLASS.EDGE` (z-30) and the scroll cue is
  `Z_CLASS.HERO_CUE` (z-31), so the cue paints over the strip where they meet.
- **Landscape.** `body.invite-page` takes the side insets, and the hero takes
  its side inset from the body. The closing band's height reserve is too large
  in landscape; a follow-up issue tracks it.
- **Limits.** A scrim or photo hero differs from the solid strip. Raised-tone
  sections show the page colour, not their own. A sheet is a top-layer dialog,
  so it paints over the strips. Behaviour on iOS Safari itself is not yet
  verified on a device.

## Adding a design

1. Catalog entry in `@cire/invite-designs` (type error in the web registry
   until step 2 lands).
2. New pack folder `cire/invites/src/designs/<id>/` + registry entry. Each pack's
   `Document.astro` owns its font preloads and islands, so guests never
   download another design's assets. The pack renders `<LoginSection>` with a
   `layout`; a new panel shape is a new row in its `LAYOUTS` table, never
   markup of the pack's own. Its hero ends with `<HeroScrollCue>` and keeps
   2.5rem of bottom padding under the title (see
   [The hero scroll cue](#the-hero-scroll-cue)); list the pack in
   `InviteHeader.ssr.test.tsx` and `InviteHeader.browser.test.tsx`. Its shell
   also renders the edge strips and puts `data-edge-hero` on the hero root (see
   [Edges in mobile Safari](#edges-in-mobile-safari)).
3. Row in `cire/host/src/components/invite/design-layout.ts` describing how
   the pack is SHAPED, so the builder's preview stops previewing it as Classic.
   Not optional — `design-layout.test.ts` asserts every catalog id has its own
   entry, so step 1 without this fails the organiser suite.
4. Tier `premium` → gate already enforced; no api change.

## Testing seams

- `AppOptions.inviteDesigns` / `createInviteOrganiserRoutes` 5th param inject
  a test catalog (the launch catalog is all-free, so premium-gate tests add a
  fixture design).
