---
"@tools/e2e": patch
---

The end-to-end suite boots the cire organiser portal (`@cire/host`, port 4322) and signs an organiser in through osn-api: a session from `/dev/login`, then the portal's real OIDC hop. Three flows run on it: `cire-checklist-starter` applies the starter checklist, `cire-checklist-holders` puts people on a task and takes them off, and removes a holder from the wedding, and `cire-helper-scope` widens, narrows and resets what a helper sees on the run sheet. Each checks the rows cire-api wrote.
