---
"@shared/infra": minor
---

The production plan guard lets a flip release update the stack's other site Workers, as long as their custom domains are read and do not change. Every cire site build bakes the release commit, so those Workers update in nearly every release, and the old rule (the flip site's own update, every other line a noop) refused every cire flip.

In a flip release the guard now refuses: a flip site that does not update or whose Worker does not gain its production host; another site Worker updating while its custom domains were not read; any other site's custom-domain change, whatever its action; any other resource that is not a noop or a site Worker's update; and any binding change. `--flip` with `--unflip` is a usage error (exit 2). `DomainReading` gains `read`, the sites whose live hosts were read, and `GuardInput` gains `sites` and `domains`.
