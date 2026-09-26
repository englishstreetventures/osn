---
title: Cire RSVP deadline
tags: [systems, cire, rsvp, invite]
related:
  - "[[cire-organiser]]"
  - "[[cire-invite-builder]]"
  - "[[cire-auth]]"
last-reviewed: 2026-09-27
---
# RSVP deadline

An organiser sets a **"kindly respond by" date** on their wedding. Guests see it on their invite and can reply — and change their reply — right up to the end of that day. Past it the invite **locks**: the guest write path refuses, and the invite renders read-only.

A wedding with no deadline behaves exactly as cire always did. Every wedding that existed before migration 0055 reads as "no deadline", so nothing changed for anyone until an organiser opts in.

---

## The one hard problem: a date is not an instant

"1 September" names a day, not a moment. Which moment it ends depends on where you stand — and a Sydney couple's guests can be reading from London.

Cire answers it the same way the `events` table already does: **wall-clock value + IANA zone**.

| Column (`weddings`) | Type | Meaning |
|---|---|---|
| `rsvp_deadline` | `text` (nullable) | Date-only ISO `YYYY-MM-DD`, **inclusive** of its whole day. `NULL` = no deadline. |
| `rsvp_deadline_timezone` | `text` (nullable) | IANA zone the day is measured in. `NULL` ⇒ UTC. |

The lock instant is the **last millisecond of that local day** — `23:59:59.999` in `rsvp_deadline_timezone`.

The zone is never picked by hand. The organiser portal stamps the organiser's own browser zone at the moment they *choose or change* the date, which is the day they mean. Saving an unrelated field later — possibly from another country — never re-stamps it.

### Why on `weddings`, not `wedding_invite_customisations`

The customisations table is documented as *strictly presentational*: every column there changes how the invite looks. This pair gates a **write**. Putting it on `weddings` keeps that table's contract honest and puts the deadline next to `wedding_date`, the other planning fact it belongs with.

### The single source of the instant

`cire/api/src/lib/rsvp-deadline.ts` is the only place a date becomes a moment.

```ts
resolveRsvpDeadline(date, timezone, now)
  // → { date, timezone, closesAt, closed } | null
isRsvpClosed(date, timezone, now)  // → boolean
```

Everything — the guest write gate, the claim payload, the guest banner — goes through it, so the server's 403 and the invite's "closed" copy can never disagree about when the door shut.

Offsets come from `Intl.DateTimeFormat` (no tz library on a Worker): format the instant into the zone, read the wall-clock fields back, and subtract. It runs **two passes** — the first offset is sampled at the UTC-interpreted instant, which is up to a day away from the real one and so can land on the wrong side of a DST transition; re-sampling at the corrected instant settles it. That is what makes "the end of 5 April in Sydney" resolve at `+10` (the day *ends* on AEST) rather than the `+11` in force when it began.

Formatters are **cached per zone** and reused across both passes (P-W1). Construction is the expensive half of ICU date handling (~226 µs/call vs ~16 µs cached) and this runs on every claim and every RSVP submit, against a 10 ms Workers CPU budget. Only *successful* lookups are cached, which is what bounds the map: a miss stores nothing, so junk input can't grow it, and canonicalisation on write (below) means only canonical identifiers ever reach it.

### Zones are canonicalised on write

`Intl` accepts more than "IANA identifier" — `"+05:30"`, `"utc"` and `"AUSTRALIA/sydney"` all construct. Storing those verbatim would mean a fixed-offset deadline that never applies DST (drifting an hour across a transition) and one zone spelled several ways in the column, so `canonicalTimeZone` resolves through `resolvedOptions().timeZone` and rejects anything whose resolved form is an offset (S-L2). It is deliberately **not** cached — it takes organiser-supplied strings, and caching by input would let case variants of one real zone grow a map without bound. It runs on a rare owner-gated write, never on a hot path.

### Failing open

Both degradations fail **open**, never closed:

- a stored date that isn't a real calendar date ⇒ **no deadline**;
- a zone this runtime can't resolve ⇒ **UTC**.

Locking guests out of an invite because of a data problem is the worse failure. The write path validates both at the boundary (`cire/api/src/schemas/settings.ts` — the zone is checked against the runtime's own ICU data, not a regex), so reaching either branch means data written by something else.

---

## Who the deadline stops

| Path | Gated? | Why |
|---|---|---|
| `POST /api/rsvp` (guest invite) | **Yes** — 403 `{ "error": "rsvp_closed" }` | The point of the feature. |
| `PUT …/guests/:guestId/rsvps/:eventId` (organiser-recorded) | **No** | A phone/paper reply arriving after the date is exactly the case the deadline creates. The organiser set the date; they can answer for it. |
| Host-preview family | Already 403 | Preview sessions never write real RSVP data, deadline or not. |
| `PUT` / `DELETE /api/plus-one/:guestId` (the household's plus-one) | **Yes** — 403 `rsvp_closed` | Same predicate and instant as the reply: the plus-one prompt locks when the replies do ([[cire-plus-ones]]). |
| `PUT …/plus-one` permission routes (organiser) | **No** | Same reasoning as the organiser-recorded reply. |

Enforcement lives on the **write**, not only in the UI: a stale tab, or anything talking to the API directly, must not be able to slip a late reply in. The route reads the deadline in the same join it already makes for the family's `kind`, so the gate costs no extra round-trip — and **fails closed on a zero-row join** (S-L1), since both gates read that one result and optional chaining would have made a missing row answer "allow" to each of them.

`cire.rsvp.blocked{reason}` counts refusals — `deadline` or `preview`. The plus-one routes count theirs on `cire.plus_one.blocked{reason}`.

---

## What the guest sees

The deadline rides the **claim payload** (`ClaimResponse.rsvpDeadline`), not the public `GET /api/invite/:slug` — it only means anything once a household is looking at its own events, the same reasoning as the closing section beside it.

```jsonc
"rsvpDeadline": {
  "date": "2026-09-01",
  "timezone": "Australia/Sydney",
  "closesAt": "2026-09-01T13:59:59.999Z",  // the instant it locks
  "closed": false                           // the verdict at claim time
}
```

### Three states, not two

The date a guest has to act on should not read the same a month out as it does in its final week, so the guest side has a **tri-state verdict**, not a boolean. `rsvpDeadlineState` (`cire/invites/src/components/rsvp-deadline.ts`) answers:

| State | When | Notice | Claim-panel line |
|---|---|---|---|
| `open` | more than 7 days to go | "Kindly respond by …" | "RSVP by …" |
| `closing-soon` | 7 days or fewer | "RSVPs close soon — kindly respond by …" | "RSVP by … — closing soon" |
| `closed` | past `closesAt` | "RSVPs closed on …" | "RSVPs closed on …" |

`null` is the fourth answer and means **this wedding set no deadline** — nothing renders. It is never returned for a real deadline, including one whose `closesAt` will not parse: that case asks `isRsvpClosed`, which falls back to the server's own verdict, and an unparseable instant the server calls open reads `open`. Nearness cannot be measured from a broken instant, and a notice that vanished while the buttons stayed locked is the failure that shape prevents.

> [!note] The seven days are measured on the instant, not on calendar days.
> `closesAt` is already the last millisecond of the deadline's day in the wedding's zone. Counting calendar days instead would mean re-deriving that zone's offset on the client — the same two-pass DST problem the API solves above — and an hour of drift at the edge of a seven-day band is invisible to a guest.

**Urgency is never carried by colour alone** (WCAG 1.4.1). Each state says something different in words as well as in shape, so a guest who cannot separate the two golds still reads the difference.

### How it re-derives itself

Both `closesAt` and `closed` are sent because a guest can sit on a claimed invite for hours. `createRsvpDeadlineState` (`cire/invites/src/components/createRsvpDeadlineState.ts`) keeps **one timer live at a time** and chains it: the effect reads its own clock signal, waits for the next boundary still ahead — the start of the final week, then the close itself — and re-arms when that one fires. Nothing polls, nothing wakes a sleeping phone, and an invite left open across the deadline locks itself instead of leading to a server 403.

Chained rather than two timers armed at once, because `setTimeout`'s delay is clamped to a signed 32-bit integer (~24.8 days) and a longer one fires immediately. A deadline **25 to 32 days out** has its near boundary inside that range and its close outside it: two independent timers would arm the first, fire it, and never arm the second, leaving that session able to reach "closing soon" and never lock. Waiting for one boundary and then measuring again from there reaches both. A boundary still beyond the range is not scheduled at all, which is what stops a far-off invite closing on sight.

One verdict drives **four** surfaces, in both the `classic` and `gala` designs:

1. **A line in the claim panel, where the guest lands** — the date as a label rather than a sentence, under the greeting: "RSVP by Tuesday 1 September 2026". Deliberately not the notice's wording, so the two copies on one page read as two statements of a fact rather than as one sentence printed twice.

   It is an **ordinary paragraph**: no `role`, no `id`, and no `aria-hidden`. Silent because it is not a live region — a second live region would read the same fact twice every time the deadline moved — but still in the accessibility tree, because hiding it would take the date away from exactly the screen-reader user this copy exists for.
2. **A line directly on top of the event cards** — one line governs every card (a per-card repeat would be four copies of one fact), so it is placed as the list's **label**, not as a third line of section header: in `classic` it sits below the centred header block, in `gala` *below* the header rule. Both hold it tight to the list (`mb-3`) with nothing between, and both **centre** it — the line speaks for the whole list, so running it along the cards' left edge made it read as a note on the first card rather than on all of them. Pinned by a DOM-position test in each pack.

   This is the copy that **announces** (`role="status"`) and the one each closed Respond button describes itself by (`RSVP_NOTICE_ID`), so it is also the one that has to stay in the DOM once the deadline passes — which it does, because a wedding with a deadline renders this line in all three states.

   **It is a `<p role="status">`, and stays one.** `<output>` is the only HTML element carrying `role="status"` implicitly, which is why `jsx-a11y/prefer-tag-over-role` names it — but `<output>` is form-associated: it has a form owner, takes `for` / `form` / `name`, and a form reset blanks it. An RSVP-by date is not the result of a calculation or of anything the guest did in a form. The live region earns its place on the other side: `createRsvpDeadlineState` chains a timer to the deadline boundaries, so this sentence rewrites itself under a guest who is only reading (`open` → `closing soon` → `closed`). The reason is stated on the `role` line in `cire/invites/src/components/RsvpDeadlineNotice.tsx`, and `tests/components/RsvpDeadlineNotice.test.tsx` pins that the announcing copy carries the role and the silent one carries none.

   **Its colour is `--color-gold-ink`, never `--color-gold`.** This is normal-size text, which WCAG 1.4.3 puts at 4.5:1, while `--color-gold` is the *metal* — rules, borders, buttons — and `derivePalette` deliberately holds it only to the 3:1 UI floor so a genuinely gold gold isn't bleached into a cream. A live invite on a taupe-on-cream scheme shipped this line at **3.35:1**: over the floor, under the bar, so nothing moved it. `--color-gold-ink` is the same hue walked to 4.5:1 against all three surfaces — the section's tone is the organiser's pick, so any of `ground` / `card` / `raised` can be the backdrop. Closed, the line drops to `--color-text-muted`, which is walked the same way. See `[[cire-invite-builder]]`.

   `closing-soon` and `closed` add a **border and padding** and nothing else: no tint behind the text. A wash between the ink and the section would composite a backdrop neither `derivePalette`'s walk nor `RESIDUAL_PAIRS` measures, which is how an organiser-side chip once shipped marked at under 2:1 with a green suite. Both packs assert the absence.

   `RsvpDeadlineNotice` (`cire/invites/src/components/RsvpDeadlineNotice.tsx`) owns the state-to-treatment mapping for all four call sites, so the packs cannot drift on which state looks like what. **Placement is still each pack's own** — spacing and alignment are passed in, and each pack's tests pin its own.
3. **Each card's Respond button** — relabelled "RSVPs closed" and marked `aria-disabled`. Relabelled rather than removed: a vanished button reads as a broken invite. **`aria-disabled`, not the native `disabled`** (C-M2): the native attribute takes the control out of the tab order, which would make the one per-card explanation of why the action is gone unreachable by keyboard, and would drop focus to `<body>` if the deadline passed while it was focused. The click handler enforces it, and `aria-describedby` points at the notice above via the shared `RSVP_NOTICE_ID`. Losing the native attribute also loses WCAG 1.4.3's inactive-component exemption, so the closed state reuses the **outlined** treatment already shipped beside it rather than dimming the filled button. *Event Details stays open* — only the answer locks.
4. **The RSVP sheet** — read-only: every control disabled, no submit button at all, the dismiss button says "Close". Normally unreachable (Respond can't be activated), but reachable if the deadline passes with the sheet already open — in which case unmounting the submit button would strand focus outside an `aria-modal` dialog, so a focus rescue moves it to the dismiss button *when nothing else holds it* (C-L2).

The dates render in the **wedding's** zone, so a guest abroad sees the date the couple wrote, not the one their own clock rolls it to.

A 403 from the write path is disambiguated by its body: `rsvp_closed` gets "RSVPs have closed for this wedding", anything else keeps the authorisation copy.

---

## Where the organiser sets it

**Settings → RSVP by**, via the same `PUT /api/organiser/weddings/:weddingId/settings` PATCH-semantics body.

It is the **one field on that panel a co-host may write**. The rest of Settings is wedding identity and money — owner-only in the roles matrix — but the deadline *runs* the wedding rather than describing it: the co-host chasing replies is exactly the person who needs to move the date, and nothing they do to it is something an owner can't undo. A `viewer` co-host still gets nothing.

A middleware can't express "this field, not that one", so the route splits the decision in two:

| Layer | Decides |
|---|---|
| `weddingEditor()` | Who reaches the handler at all — owner or `editor`; a `viewer` gets its usual 403 `read_only_role`, a non-member the 404/403 pair. |
| The handler | Whether a **non-owner's** patch reached past the deadline. Any other key present ⇒ 403 `owner_only_fields` naming them. |

Shape is checked **before** privilege, so a co-host who typos a date is told the date is wrong rather than that they lack permission for a field they're allowed to write. The refusal is whole — a patch mixing the deadline with an owner-only field writes neither — and it is logged (`settings owner-only fields refused`), because the portal never sends that body, so every occurrence is a stale tab or a hand-crafted call. Rejected rather than silently filtered: a save that reports success while quietly discarding half the form is the worse failure.

The allow-list (`ownerOnlySettingsIn`, `cire/api/src/schemas/settings.ts`) is **derived from the request schema's own field list** rather than from the incoming object's keys. Two properties fall out: a field added to `UpdateSettingsBody` is owner-only from the moment it exists (the list can't drift, because it *is* the schema), and the check reads each key the same way the writer does — `patch[key]`, through the prototype chain — so gate and writer can never disagree about what a patch contains (S-M1).

**A deadline can never be set in the past** — by anyone, owner included. `weddingSettingsService.update` refuses a write that would leave the deadline already closed with 400 `rsvp_deadline_in_past` (S-L3). A backdated date locks the invite for every guest the instant it lands, and a guest turned away is told only that RSVPs closed, never that the date moved under them. The check runs on the **resulting pair**, not on the patch — either half decides the instant, and moving the zone alone can shift an open deadline by up to ~26 hours — and it asks `isRsvpClosed`, so it cannot disagree with the guest write gate about when a day ends. Three things it deliberately still allows: **today** (the deadline is inclusive, so it closes at the end of that day — this is what "stop taking replies" actually means), a deadline that lapsed naturally staying put while other fields are edited, and clearing a lapsed deadline to reopen RSVPs. The portal mirrors the rule against the organiser's own calendar so the mistake never round-trips.

Every settings write records its author in `weddings.updated_by_osn_profile_id` (migration 0056). The panel has two principal classes now, so a change to a guest-facing lock has to be attributable: an owner who finds RSVPs closed can establish whether they did it themselves (S-L2). A refused non-owner patch is logged and counted on `cire.wedding.settings.owner_only_refused`.

The write is **narrow**: `weddingSettingsService.update` names only the columns the patch carries. The old full-row read-modify-write was harmless while the owner was the single writer, but with two principals on one row a co-host's deadline save would rewrite `displayName` and `currency` from a value read moments earlier, reverting an owner's concurrent edit to a field the gate exists to protect (S-L1). A deadline-only patch now emits a deadline-only `UPDATE`, so the field gate holds at the storage layer too. The pairing rule below still fires — but only for a patch that touches the pair, so an unrelated save writes nothing but its own columns.

Both deadline keys travel together on that list. Admitting the date without the zone would leave a co-host able to set a deadline they can't say the zone of — and the zone is what makes "the end of that day" mean anything.

The portal mirrors it: a co-host sees the profile fields disabled with the RSVP-by picker live, a **"Save RSVP-by date"** button (labelled for what it writes, since "Save settings" beside five disabled fields reads as a button about to overwrite them), and a body carrying the deadline pair *alone* — not the untouched values sitting in the disabled inputs, which would earn the 403.

The two columns are **one fact**: clearing the date clears the zone in the same write, whichever order a client sends them in, so a zone can never outlive its date and re-appear next to an empty field.

It is the only field on that panel guests feel, which is why its hint says so explicitly — and names the zone, since "the end of that day" means nothing without one.

---

## Files

| Concern | File |
|---|---|
| Columns | `cire/db/src/schema.ts` (`weddings`), migrations `0055_rsvp_deadline.sql` + `0056_settings_attribution.sql` |
| Date → instant | `cire/api/src/lib/rsvp-deadline.ts` |
| Write gate | `cire/api/src/routes/rsvp.ts` |
| Guest payload | `cire/api/src/services/claim.ts`, `cire/api/src/schemas/claim.ts` |
| Organiser write | `cire/api/src/schemas/settings.ts`, `cire/api/src/services/wedding-settings.ts` |
| Who may write it | `cire/api/src/routes/organiser-settings.ts` (gate + field check), `cire/api/src/middleware/wedding-editor.ts` |
| Organiser UI | `cire/host/src/components/SettingsPanel.tsx` |
| Guest UI | `cire/invites/src/components/rsvp-deadline.ts`, `createRsvpDeadlineState.ts`, `RsvpDeadlineNotice.tsx`, `LoginSection.tsx`, `EventCard.tsx`, `RsvpModal.tsx`, `designs/{classic,gala}/InvitePage.tsx` |
