---
"@cire/db": minor
---

Grow the dev seed to the shape and size of a real wedding: five events with
images, co-hosts, comped entitlements, invite customisation, replies with a
correct dietary-consent stamp, and 195 generated households on top of the four
hand-written ones. Add `assets:seed:dev`, which uploads a placeholder image for
every R2 key the seed points at. Drop the reset's tables children first — the
`defer_foreign_keys` pragma does not survive wrangler's statement-per-line
batching, so the old alphabetical order failed once a parent went first.
