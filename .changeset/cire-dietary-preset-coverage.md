---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
---

Cover `rsvps.dietary_presets` end to end, and fix the two defects the coverage
found. Special-category data under GDPR Art. 9 behind an Art. 9(2)(a) consent
gate, and its failure mode is silent: `parsePresets` is total, so a broken round
trip returns `[]` rather than throwing, and a reopened gate stores the data with
no consent record while every existing test stays green.

**Two source changes, not tests alone.**

- `@cire/api`: a reply with `status: "declined"` no longer bumps the
  `cire.rsvp.dietary_preset.selected` counter. The counter answers "how many
  plates need this", and a guest who is not coming needs none. Only the metric
  moves — a declined reply still stores its presets, and the 422 consent gate
  still applies to it. `maybe` keeps counting, and the counter's description
  says so.
- `@cire/invites`: `isValidClaimResponse` now checks the `dietaryPresets` and
  `dietaryConsentCurrent` its return type already asserted. Preset keys are
  checked as strings rather than against the closed vocabulary on purpose: both
  callers read an invalid response as "no session", so a key added server-side
  would otherwise strand a guest on a site that had not redeployed yet.

**A metrics test harness for `@cire/api`.** Cire's counters resolve through
OpenTelemetry's global provider, and with none installed that is the NoOp meter
— so before this a metric test passed with the metric call deleted. `bun test`
now preloads `tests/test-helpers/metrics-harness.ts`, which installs an
in-memory `MeterProvider` before the first instrument is built and exposes
`counterValue(name, attrs)`. Adds `@opentelemetry/sdk-metrics` and
`@opentelemetry/api` as devDependencies of `@cire/api`.

**Coverage**, each case verified by reverting the behaviour it describes:
the organiser route's 422 gate for a preset-only reply; the `cire/host`
record-a-reply editor's consent-visibility rule (with a viewport helper, since
the picker collapses behind a popover above 48rem); `dietaryConsentCurrent` in
both the claim and RSVP services; presets through both export paths (the caterer
CSV and the dashboard view); the `schemas/rsvp.ts` preset union and its length
cap; the preset counters and the `dietary_consent` blocked reason; and the
`cire/landing` demo's picker and free-text reveals.
