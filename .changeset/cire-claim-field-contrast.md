---
"@cire/invites": patch
---

Guest invite: make the claim code field legible and properly labelled, and give
the form's visibility a single owner.

Reported as "the claim input box is disappearing sometimes", with a screen
recording from a phone on 4G.

**The field was invisible.** Measured against the live invite's palette, the
input's fill was `bg-transparent` — literally 1.00:1 against the section behind
it — and `border-border` (the scheme's ink at 0.12 alpha) put its outline at
1.27:1. On a pale scheme that is a cream rectangle on a cream band, and it reads
identically to the outlined submit button below it. Fill and border now come
from `--color-text` at 0.045 / 0.55: **1.09:1 and 3.53:1** on the live palette.
The border alpha is set by WCAG 2.1 SC 1.4.11, which asks 3:1 of the visual
boundary identifying a control — 0.55 is the lowest value clearing it on the
worst preset/tone pair (garden/ground, 3.23:1), found by compositing over every
`PALETTE_PRESETS` entry × all three section tones in a real browser.
Ink-at-alpha rather than a surface token on purpose: the organiser picks which
surface this section sits on (`welcome_tone`: ground / card / raised), so any
fixed token vanishes on the tone that matches it, whereas ink steps away from
whatever is actually behind it on every palette and in the right direction.

The input also gains `aria-label="Invitation code"`. It had only a placeholder,
which is not an accessible name and disappears on input — so the page's one
control was an unnamed edit field to a screen reader or voice control.

Both packs carry all of it; gala renders its own claim markup rather than
reusing `LoginSection`, so both are pinned by tests against silent divergence.

**The form's visibility now has one owner.** `unlockRevealSequence` wrote
`loginForm.style.display = "none"` directly on an element whose `display` is
also a reactive SolidJS binding. Solid diffs a style binding against the last
value *it* wrote, so that imperative write didn't duplicate the binding — it
desynchronised it: Solid went on believing `display` was `""` and would skip
every later attempt to show the form again, for the life of the page. Latent
today only because nothing sets `claimResult` back to `null`; a sign-out or a
rolled-back claim surfaces it immediately.

The sequence now *reports* the swap through an `onFormHidden` hook and never
touches `display`; the island owns it through one `revealed` signal, which
`LoginSection` reads via a new optional `revealed` prop (absent ⇒ derived from
`result`, so callers that don't choreograph — and the greeting tests — are
unchanged). `handleClaimed` sets it in a `finally`, so a motion chunk that fails
to load can no longer leave the code form sitting on top of a claimed invite —
previously that was covered only incidentally, by the binding this replaces. The
three signal writes on the session-restore path are now wrapped in `batch`, so
`revealed` can never be observable ahead of the result that justifies it.

It also fixes the fade the choreography was written for: deriving `display` from
`claimResult` meant Solid hid the form the instant the claim resolved, a beat
*before* the sequence ran, so step 1 was animating an already-invisible element.
The form now stays on screen for its own fade-out.

**Root cause of the disappearance is NOT confirmed, and nothing here claims to
fix it.** Ruled out by reproduction against the live wedding's exact palette, on
both the dev server and a real `wrangler dev` production build: a slow, failed or
stalled `GET /api/invite/:slug` revalidation; a Solid `Suspense` fallback (Astro
wraps every island in one, but the resource carries an `initialValue` and never
suspends); hydration-key mismatch; the returning-guest session restore; and every
Turnstile failure mode. An earlier revision of this branch also switched the
island from `client:visible={{ rootMargin: "600px" }}` to `client:load` on the
theory that hydration was landing under the guest's finger; that was **reverted**
after measurement showed the claim section starts at exactly `100dvh` (the hero
is `min-h-dvh`), so a 600px root margin already intersected at scroll 0 and the
island was hydrating at load either way. What remains is WebKit-specific and
needs a real device.
