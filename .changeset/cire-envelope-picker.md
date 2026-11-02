---
"@cire/host": patch
"@cire/api": patch
"@tools/e2e": patch
---

Organisers can choose their wedding's envelope in the invite builder. An envelope picker sits under the design cards: "None" by default, or the Wax seal, saved at once. Every envelope is premium, so a wedding without Crimson or the `premium_templates` entitlement sees the Wax seal locked, and a stored envelope the wedding may no longer use shows as switched off. The picker stays hidden on an API older than envelopes. While an envelope is chosen, a note says when the hero is switched off or empty, since the envelope opens onto it. Guests do not see envelopes yet. "Preview invite" now adds `envelope=1` to the preview address. The E2E stack gives the holders wedding a comped `premium_templates` row, and the `cire-checklist-holders` flow picks the Wax seal, reloads to see it held, and sets None again.
