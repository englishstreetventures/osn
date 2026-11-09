---
"@shared/infra": patch
"@musubi/infra": patch
---

A flip release keeps a DNS record for the host it moves. The Alchemy provider patch adds a replacing Worker custom-domain attach: with `OSN_WORKER_DOMAIN_REPLACE_CNAME=<host>=<project>.pages.dev` set, the Worker whose one custom domain is that host attaches it with the request Wrangler sends, replacing the CNAME the detach kept in one step, and refuses, writing nothing, a host holding anything but that CNAME, or an apex holding anything beside it. Unset, every attach runs as before. `production-hosts` writes `replace_cname`, the value a flip's deploy passes, empty on any other release, and `flipReplaceCname()` gives it per site. A failed D1 import reply now reports only Cloudflare's error codes and messages, or its status and length, never its text. The domain move rehearsal's flip deploys the same way, holds the detached host for `hold_minutes` first, and fails unless the zone's own name servers answered a record for the host at every read.
