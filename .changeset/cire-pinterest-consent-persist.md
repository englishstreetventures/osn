---
"@cire/web": patch
---

Make the Pinterest board consent gate a one-time, page-wide opt-in. Consent now
persists in localStorage (survives the visit, never re-prompts on return) and is
backed by a single shared signal, so accepting on one board immediately reveals
every other Pinterest board on the page. Adds a link to the privacy notice in the
consent prompt.
