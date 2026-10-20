---
"@cire/invites": minor
"@cire/theme": patch
"@cire/landing": patch
---

The event details sheet leads with its key facts

On the guest invite, the details panel now opens on what a guest came for.
Under the heading and the RSVP button (unchanged) comes a short list: when,
where and, for a household not all of whom are invited, who is. One hairline,
then the occasion: about, dress code and the moodboard.

- **When** names both days for an event that ends on a later day ("Fri 6:00 pm
  – Sun 11:00 am"), spells the timezone out ("AEDT (Sydney time)"), and adds the
  guest's own time when their clock reads differently. Add to calendar is a
  text action on that row, underlined so it reads as one on a phone. Its menu
  now answers the arrow keys, Home and End, has 44px items, opens upward when
  there is no room below, and hands focus back to "Add to calendar" when a
  calendar is chosen.
- **Where** shows only when something can open a map. It holds the address, a
  compact map card drawn in the invite's own colours (or the Google map once
  the guest allows it), and "Open in maps".
- **The closed notice** uses the same closed style as the rest of the invite.
  It tells the household to contact the couple directly, and it is announced
  if the deadline passes while the sheet is open.
- **Swatches** sit in a grid, each named as the organiser wrote it, with a ring
  that stays visible on every scheme.
- **Inspiration** is one block: "Open on Pinterest" and "Show it here". The
  block says what showing it switches on, and nothing loads from Pinterest
  before the guest says yes. Once it is on, "Stop showing moodboards" under the
  board switches it off again from the sheet, so taking it back is as quick as
  giving it.
- **Fixes:** the consent placeholder now reads as a sentence, every control in
  the panel is at least 44px tall, the timezone text meets 4.5:1, and pressing
  "Show it here" leaves focus inside the sheet.

`@cire/theme` now derives `--color-border-strong` (the boundary of an unfilled
control) per scheme. It is solid, and held to 3:1 against the card, raised and
ground surfaces. On the fog, chapel and garden presets it used to keep
evergreen's cream, at about 1:1. A new residual warning, `border-strong-on-surface`,
tells the organiser about any scheme where the derivation cannot reach 3:1.
`@cire/landing` takes the same evergreen value, keeping its brand tokens equal
to the guest site's.
