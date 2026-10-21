---
"@tools/e2e": patch
---

The end-to-end suite's organiser portal flows get weddings of their own and a shared sign-in. The stack starts cire-api with `CIRE_E2E_ORGANISER=1`, which adds three Gold weddings the dev profile owns (`CIRE_ORGANISER`), and `signInToCireHost` signs that profile in: a session from osn-api's `/dev/login`, then the portal's real OIDC hop, checking that Musubi's `/authorize` page never loads and that cire-api writes one organiser session. Three flows run on it: `cire-checklist-starter` applies the starter checklist, `cire-checklist-holders` puts people on a task and takes them off, and removes a holder from the wedding, and `cire-helper-scope` widens, narrows and resets what a helper sees on the run sheet. Each checks the rows cire-api wrote. `tests/flows.test.ts` fails above five organiser sign-ins a run, counting a flow that signs in through `/dev/login` itself as well as the fixture's callers.
