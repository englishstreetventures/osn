---
"@cire/web": patch
"@cire/organiser": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Self-host Cormorant Garamond + Lato via Fontsource on every cire surface —
closes **C-L33** by deleting the Google Fonts data flow instead of papering it
with a subprocessor row.

All four sites (guest incl. legal + 404, organiser, vendor, landing) replace
the `fonts.googleapis.com` stylesheet links + preconnects with
`@fontsource/*` per-subset CSS imports (latin + latin-ext, mirroring what the
Google stylesheet served; `font-display: swap` and the family names are
unchanged, so rendering is identical). Vite bundles the WOFF2 files as hashed
same-origin `/_astro/*` assets with immutable cache headers — no guest or
organiser request reaches Google, and font binaries are still fetched only
when rendered text matches a face.

Face sets are scoped per page: the invite design packs and the
organiser builder load the full typography-option set (300/400/600/700 +
italics, so a bold/italic pick renders a real face), while login / legal /
vendor / landing pages load only the faces they use — this also resolves the
P-I1/P-I2 stylesheet-bloat notes from the typography PR. The invite packs
preload the hero-title face (Cormorant 300 latin) same-origin, replacing the
old async-stylesheet trick and its inline `onload` handler.

CSP tightened to match: `fonts.googleapis.com` leaves `style-src` and
`fonts.gstatic.com` leaves `font-src` in the guest SSR middleware
(`security-headers.ts`), its `public/_headers` mirror, and the landing
`_headers`; the guest CSP test now asserts the Google hosts' **absence** so a
regression re-opening the flow fails loudly.

Reconciled with the site-wide consent framework (#329), which had declared
Google Fonts its one ungated (`enforcement: "always"`) vendor: the
`google-fonts` entry is deleted from the consent vendor registry (satisfying
its own registry-origins-⊆-CSP test), the preferences dialog and `/privacy` no
longer disclose an ungated fonts vendor (tests flipped to assert the absence;
`necessary`-category Turnstile keeps its "loads on every visit" disclosure by
design), the `/privacy` owner-note is replaced by a plain "typefaces are
served from this site" line, and `CONSENT_POLICY_VERSION` is bumped to
`2026-07-30` so stored decisions re-prompt against the reduced disclosure.
The Google Fonts subprocessor row is retired to Removed processors (the Fonts
half of C-M20).
