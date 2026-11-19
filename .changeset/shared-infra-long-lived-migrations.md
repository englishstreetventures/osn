---
"@shared/infra": minor
---

`MigrationSources` takes `longLived`: a directory of migrations a squash moved
out of `source`, handed over byte for byte, the first in place of `source`'s
baseline. A name both directories hold other than that baseline is refused.
