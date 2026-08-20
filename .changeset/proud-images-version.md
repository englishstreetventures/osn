---
"@cire/api": patch
---

Give each invite image slot its own cache-key version.

The `?v=` version for the hero, story and footer slots came from one
per-wedding `images_updated_at` column, so re-uploading a single slot moved
every slot's URL — guests re-fetched images whose bytes had not changed, and
the whole wedding's transform cache was orphaned at once. Each slot's version
is now an FNV-1a digest of its own R2 key, which moves exactly when the bytes
move. The hero digest also folds in the backdrop blur radius, because that blur
is applied server-side to the `hero-bg` variant and the response is cached
`immutable` for a year.
