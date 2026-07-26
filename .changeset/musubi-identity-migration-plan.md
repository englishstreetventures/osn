---
---

Docs: add `[[musubi-identity-migration]]` — the cutover plan for moving osn-api
from `id.cireweddings.com` to `id.musubi.dev` with musubi.dev as the full OSN
identity home.

Records the two blockers that make this more than a hostname swap (the
`[[authorize-ui]]` consent page is still unbuilt, and `@osn/social` has no
deploy job), the RP-ID change that invalidates every existing passkey, the
recovery-code credential bridge that survives it, the full config inventory,
and the cutover order.

Also updates `wiki/TODO.md`: the `OSN_PAIRWISE_SALT` item is no longer
hypothetical — prod osn-api has been returning 503 on every route since PR
#315's deploy on 2026-07-24, because the fail-closed boot check shipped one PR
ahead of the workflow that sets the secret. Adds a follow-up for a deploy
preflight that would have caught it.
