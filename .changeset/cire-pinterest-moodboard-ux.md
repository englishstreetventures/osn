---
---

Pinterest moodboard: split the guest experience by input capability so it works
reliably on every device, and keep the privacy-sensitive tracker off mobile.

- **Touch / mobile (coarse pointer, no hover):** render a single, prominent,
  instantly-working "View moodboard on Pinterest" card that opens the board in a
  new tab. The third-party `pinit_main.js` tracker is **never loaded**, the
  consent gate is **never shown**, and the embed is **never mounted** — no
  tracker means no consent is needed and there is nothing to fail. Fixes the
  repeatedly-failing mobile UX (the consent button appearing to have "no effect"
  because the embed it revealed sat blank for the multi-second cutoff while the
  unreliable widget loaded). Detected by capability (`matchMedia("(hover: none)
  and (pointer: coarse)")` + a coarse-pointer-on-narrow-viewport fallback), not
  UA sniffing. A consent persisted from a desktop visit is ignored on touch.

- **Desktop (hover + fine pointer):** keep the consent-gated rich embed, but give
  immediate feedback — granting consent now shows a "Loading board…" spinner the
  instant the click lands, so the user never sees a dead blank slot between the
  click and the embed rendering (or the connection-scaled cutoff falling back to
  the link). The always-visible fallback link, page-wide persisted consent, the
  success-observer cutoff, and the overflow-scroll box are unchanged.

The tracker is now desktop-only; touch is a tracker-free link-out. Needs
real-device verification (CI/happy-dom can't exercise the live widget or true
touch media queries).
