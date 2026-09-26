---
"@cire/invites": minor
"@cire/theme": patch
"@cire/host": patch
---

The claim and welcome panel is one component in every invite design, and it
holds the household's controls.

- `@cire/invites`: `LoginSection` takes a `layout` (`band` for classic, `panel`
  for gala) and draws the panel for both packs; gala no longer keeps its own
  copy. The Pulse account link moves from the bottom of the events section into
  the welcome panel, above "Not {name}? Sign out", and stays lazy: its chunks
  start downloading when a claim or session restore begins, never at idle for
  every visitor. The panel now sends the sign-out revoke (and, outside host
  preview, ends the account link's OSN sign-in) and records the restore hint
  itself.
  Classic's claim headings follow the organiser's heading typography, as gala's
  already did.
- `@cire/theme`: the typography fallback guard also scans
  `cire/invites/src/components`, where the claim headings now live.
- `@cire/host`: comment only — `design-layout.ts` names the shared panel.
