---
title: "The RSVP dwell is a budget, and its floor is an accessibility floor"
tags:
  - decision
  - cire
  - accessibility
  - frontend
related:
  - "[[cire]]"
  - "[[cire-rsvp-deadline]]"
  - "[[browser-tests]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# The RSVP dwell is a budget, and its floor is an accessibility floor

When a guest saves an RSVP, the cire invite's sheet swaps its Save label to
"Saved", locks its controls, and holds before closing itself. Two constants
govern that hold, and they are different kinds of number:

| Constant | Value | What it is |
|---|---|---|
| `SAVED_DWELL_MS` | 600 | A **budget** spent from the click. Whatever the request spent is deducted from it |
| `SAVED_DWELL_MIN_MS` | 500 | A **floor** under the budget, sized by the spoken announcement |

The code is `cire/invites/src/components/rsvp-saved.ts`.

## Why the sheet holds at all

A sheet that is simply gone is indistinguishable, to a guest, from a mis-tap
that dismissed it — the reply is recorded and nothing says so.

## Why a budget, not a fixed hold

A fixed hold started when the reply lands **stacks on the round-trip**, and the
RSVP POST is six serialised D1 round trips behind a Worker: half a second of
"Saving…" before the hold even begins, which guests read as "quite a delay for
the form to close after you click save". A budget spent from the click means a
slow reply eats the hold instead of adding to it.

Be precise about how far that goes, because the floor bounds it. Up to the
**knee** — a reply of `SAVED_DWELL_MS - SAVED_DWELL_MIN_MS` — the budget is
spent exactly and click-to-close is flat at `SAVED_DWELL_MS`. Past the knee the
floor takes over and the total is `request + SAVED_DWELL_MIN_MS`, which grows
with the network again. With the floor sized for the announcement the knee is
small, so most real saves land past it and what they actually get is the floor
rather than the budget — `900 → 500` of dwell, a flat saving, rather than the
constant click-to-close the framing might suggest. The budget still does the
work it can: it compresses fast replies, and it caps nothing at more than
`SAVED_DWELL_MS`.

`rsvp-saved.test.ts` pins the knee as a *relationship between the two
constants*, so it stays true of whatever they are retuned to.

## Why the floor is 500 and not something snappier

The floor is sized by the **spoken** confirmation, not the visible one — the
label swap would be legible in half the time.

The sheet's `sr-only role="status"` region is the reliable announcement path
(the toast's own region is created together with its content, which assistive
technology routinely misses). The dwell timer calls `props.onClose()` directly,
with no `modalExit` grace period, so the parent unmounts that region on the same
tick the dwell expires while `AnimatedModal` returns focus to the Respond
button. A polite region mutated and then destroyed a few hundred milliseconds
later, against a competing focus utterance, is at the edge of what iOS VoiceOver
reliably speaks (WCAG 2.2 SC 4.1.3) — and this is a phone-first invite, so
VoiceOver is the primary assistive technology.

The floor is the **common** case, not the tail: it binds for any reply slower
than `SAVED_DWELL_MS - SAVED_DWELL_MIN_MS`, and the POST is six serialised D1
round trips.

So it is an accessibility floor wearing a timing constant's clothes, and the
~100ms it costs a fast save is the price of the announcement being heard.

## Getting the floor's cost back

Not by lowering it. Hoist the live region to the page root, beside the
`<Toaster>` (relocated there for a structurally identical reason), so the
announcement's lifetime stops depending on the dwell. Once the region outlives
the sheet, the floor is free to come down to whatever the visible label swap
needs.

## What would make this worth revisiting

- The live region moves to the page root, which is the change that makes the
  floor negotiable.
- The RSVP POST stops being six serialised round trips, which moves the knee and
  makes the budget bind in the common case rather than the floor.
- A VoiceOver measurement, rather than an edge-of-reliable judgement, puts a real
  number on what the announcement needs.

Nothing downstream is timed against these constants: the Respond-button
celebration is measured from the moment the sheet uncovers that button (see
`rsvp-responded.ts`), and the toast is already up and stays up past the close. So
shortening the dwell shortens the wait and nothing else.
