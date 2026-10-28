---
title: Cire RSVP table — the host portal's replies page
tags: [systems, cire, rsvp, organiser, web]
related:
  - "[[cire]]"
  - "[[cire-host-portal-layout]]"
  - "[[cire-rsvp-changes]]"
  - "[[cire-plus-ones]]"
  - "[[component-library]]"
last-reviewed: 2026-10-28
---
# The RSVP table

Guests → RSVPs in the host portal (`cire/host/src/components/RsvpView.tsx`)
shows who replied to each event and who still owes a reply. It reads
`GET /api/organiser/weddings/:weddingId/rsvps`, the same read the Overview card
uses, and an owner or editor records a phone or paper reply from a row. This
page covers what the host sees and what each control does; how the page sizes
and scrolls is in [[cire-host-portal-layout]], and the "New" badges and the
change log behind them in [[cire-rsvp-changes]].

An owner downloads the RSVP sheet here with "Download RSVPs (CSV)", the same
`rsvps.csv` the Guests tab offers. It covers every event, whichever one this
page shows. Editors and viewers get no button, since the API gates the file
with `weddingOwner()` ([[cire-auth]]), and none shows while no event invites a
guest.

## One event at a time

A tab strip in the module's view bar, beside the sub-tabs and outside the
module's tab panel, picks the event (`role="tablist"`, named "Events"). The arrows, Home and End move focus and Enter or Space chooses, as
on the module sub-tabs: a 900-row event is not drawn in an instant, and every
choice writes the address. Each tab's accessible name is an `aria-label` in
sentence case — "Reception, 300 guests" — since the label itself is set in
capitals. Its ids carry a per-view prefix (`rsvp-<id>-tab-<n>`,
`rsvp-<id>-panel`) and never meet the module shell's `subtab-*` and
`subpanel-*`; each tab's `aria-controls` names the event's panel.

**The address names the event**: `#/w/<weddingId>/guests/rsvps/<eventId>`
(`cire/host/src/lib/dashboard-route.ts`), so a reload or a shared link opens
the same event. This is the one page whose address goes past its sub; any
other page ignores a fifth segment, and `parseRoute` drops a dot segment as it
does for a wedding id. A tab click writes the address with `replaceState`, as a
sub-tab switch does. With no event named, or one the API no longer returns, the
page opens on the first event and leaves the address alone until the host picks
a tab. The event id only ever picks among the events the API returned; a save
goes to the shown event's own id. Leaving RSVPs through the rail or the
sub-tabs and coming back opens the first event; Back returns to the one that
was open, because the switch replaced the history entry rather than adding one.

## The event's controls and panel

The search box and the reply chips sit in the view bar's second row, under the
event strip, so they stay to hand however far down the list the host is. They
filter every event; the table shows the event on screen, and each tab counts
what they leave in its own event, so a search run on one event still says
where else it finds guests. The search's name ("Search Reception guests") and
placeholder, the chips' group name ("Filter Reception by reply") and the status
line name the event the table shows, and the search names the event's panel
through `aria-controls`. The chips count that event's rows whatever the search.
The search, the chip and the sort stay when the event changes. On a panel too
narrow for the table the chips and the sort are two selects instead.

A search, a chip, a sort or another event made deep in the list brings the
list's top back to the foot of the stuck chrome, and leaves focus where it was;
made with the list in view, it moves nothing
(`cire/host/src/lib/scroll-to-results.ts`).

The panel, top to bottom:

1. **The tally** — Attending, Declined, Maybe, No reply, Invited — the API's
   own numbers for the event. They are not the chips' counts: `invited` comes
   from the event's guest list, and a guest taken off the event after replying
   keeps a reply row.
2. **The status line** ("Showing 3 of 120 guests for Reception.") while a
   search or chip is on; kept out of the stuck bar so the bar is one height
   whatever is typed.
3. **The table**, with a row per guest invited and a form under a row while a
   reply is recorded. It scrolls with the page, its head row stuck under the
   view bar. On a narrow panel each guest is a block instead — name and
   badges, household, reply and dietary answer, the button — with the form as
   a block under it. An open form stays with its own event across a switch,
   typed text and all, and shows again on return; a filter that hides its row
   still closes it.

**A tab says "New"** while its event holds a reply changed since the host last
looked, whatever the search, and its accessible name adds "changed since you
last looked". Opening the page marks every event's changes seen
([[cire-rsvp-changes#The portal]]), so the tab is how a change on an event not
on screen gets shown.

## Sorting

The Guest and Household heads each hold a button; a click sorts ascending, a
second click reverses, and the `th` carries `aria-sort` while its column is the
one sorted (`sortRows` and `nextSort` in `cire/host/src/lib/rsvp-filter.ts`).
The sort is the view's, not the address's.

| Head | Order | Ties and blanks |
|---|---|---|
| Guest | Surname, then first name, in the host's locale with case and accents ignored ("de Vries" beside "De Vries", "Ó Súilleabháin" among the Os) | A blank surname (`guests.last_name` defaults to `''`) comes after every surname, in both directions; ties keep their order |
| Household | Household name, then household code, so two households with one name never interleave | Inside a household the rows keep the order they came in: replies, then the guests still to answer, each in the API's order. A blank household name comes last |

Sorted by Guest, a plus-one files under their own surname, and the line under
their name still says who brought them ([[cire-plus-ones#The RSVP table]]).
Rows are sorted when the rows or the sort change and filtered on each
keystroke, so typing never sorts.

## Tests

`cire/host/tests/lib/rsvp-filter.test.ts` and
`cire/host/tests/lib/dashboard-route.test.ts` hold the sort and the address
rules; `RsvpView.test.tsx` and `RsvpView.changes.test.tsx` the panel, the
counts and the New marks in happy-dom; `RsvpView.events.browser.test.tsx` the
tab list, keys, sorting and stuck head row in real Chromium inside the real
`ModuleShell` ([[browser-tests]]); `GuestsStack.browser.test.tsx` the stuck
stack, the search moves and the narrow line.
