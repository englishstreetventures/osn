---
"@cire/host": patch
---

Three host-portal fixes, all in the event/invite editors.

**The events date picker did nothing.** The drawer reads each date back out of
the ISO timestamp it just wrote, and `joinIso` collapsed to `""` whenever either
half was missing — so on an event with no time yet (i.e. every newly-added one)
picking a day emitted `""`, the picker re-read `""`, and the trigger went
straight back to "Pick a date…". A date with no time now round-trips as the bare
`YYYY-MM-DD`. It is deliberately still not a valid timestamp: `validateDraft`
reports "Start time is required" and Save stays disabled, so the half-entered
state is visible and blocking rather than invisible and silent, and the editor
never invents a midnight for a time nobody typed. (That guard is client-side —
the DesiredState front door does not enforce `isIsoTimestamp` on `startAt` at
all, which is pre-existing and tracked as S-M1, now promoted since this client
mirror became the only thing holding the invariant.)

**The UTC-offset picker is gone; events carry a timezone.** An offset is a fact
*about* a zone on a particular date, not a property of the event, so asking for
it alongside a free-text IANA name gave two ways to say one thing and no way to
catch them disagreeing ("+10:00" on a Sydney wedding in November was simply
wrong and nothing noticed). The drawer now has one grouped timezone dropdown,
seeded on a new event with the organiser's own zone, and derives the offset for
each timestamp from that zone on that event's own date — DST included. Changing
the zone re-stamps Start and End together in one patch, keeping the wall-clock
times put. New `lib/timezones.ts` holds the helpers (shared with the settings
panel's deadline zone), including a client-side `canonicalTimeZone` so a
fixed-offset pseudo-zone can't answer with a DST-blind constant and so the
formatter caches key on a finite set. A blank stored zone renders as an
explicit empty option: a `<select>` whose value matches no option displays the
FIRST one, so a legacy row with `timezone: ""` otherwise read as
"Africa/Abidjan" while the draft still held "".

**The invite builder's live preview ignored the design pack.** Colours, fonts
and copy were exact while the layout — the one thing a design pack actually is —
was a fiction, so switching Classic → Gala changed the radio card and nothing
else. The preview (sticky pane, mobile modal and the inline per-section cards)
now follows the pack: hero centred vs anchored bottom-left, copy centred vs
left-aligned, the code-entry section as a full band vs an inset panel, and
gala's hairline under the events header. `design-layout.ts` holds the per-pack
shapes with a drift guard asserting every catalog design has its own entry, so
a new pack fails a test rather than silently previewing as Classic.
