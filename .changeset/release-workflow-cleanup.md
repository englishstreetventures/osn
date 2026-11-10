---
"@shared/infra": patch
"@musubi/infra": patch
---

The plan guard reads neither `--flip` nor `--unflip`, and its record carries no `flip` or `unflip` key. A Worker giving up its production host, another site's host, or one the code does not name is refused in every release; the refusal says to take the host off in the Cloudflare dashboard first. `GuardInput` loses `flip`, `sites` and `domains`, `domainRefusals()` its `unflip` argument, `planRecord()` its `flip` and `unflip` fields, and `DomainReading` its `read` list, which only the flip rules read. `@musubi/infra`'s `plan:guard` usage comment follows.
