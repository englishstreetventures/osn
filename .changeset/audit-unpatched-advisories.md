---
---

chore: let the pre-push audit pass by ignoring two high advisories that have no fixed release and that no deployed build contains: braces 3.0.3 (GHSA-vfj7-8cjw-p6xm) and http-cache-semantics 4.2.0 (GHSA-ch52-4w7c-c8xp). Each ignore carries its reason and drop-trigger in `lefthook.yml`.
