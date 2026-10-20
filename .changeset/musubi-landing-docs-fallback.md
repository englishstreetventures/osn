---
"@musubi/landing": patch
---

The footer's Docs link falls back to `https://github.com/englishstreetventures/osn#readme` when `PUBLIC_DOCS_URL` is unset. It fell back to an `osn-social` repository that does not exist.
