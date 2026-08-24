---
"@cire/api": patch
"@cire/host": patch
---

Drop the one-release `/import/*` alias for the change API. The canonical
`/changes/*` routes are now the only front door, and the apply/revert body
field is renamed from `importId` to `changeId` (it names a change, not an
import). The host portal's Import, Guests, Events and Change History panels
send `changeId` only.
