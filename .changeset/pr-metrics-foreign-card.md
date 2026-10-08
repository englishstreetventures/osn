---
"@tools/pr-metrics": patch
---

`card` no longer writes over a session-metrics card that names another pull request. Transcripts are joined to a card by branch name alone, so a branch name reused from an earlier pull request built one card holding both pieces of work and wrote it over the earlier one's committed record. When the card on disk names a pull request other than this run's, a run that resolved none included, `card` prints both numbers on stderr, writes nothing, renders no `--format markdown` block and exits 1. A card that names no pull request is still replaced.
