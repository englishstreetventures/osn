---
---

Prune the transitional apex `cireweddings.com` (now the static marketing
landing, makes no API calls) and `app.cireweddings.com` (old organiser origin)
from cire-api's production `WEB_ORIGIN` allowlist now that the guest site lives
on `invite.` and the organiser portal on `host.`. Config-only (`cire/api`).
