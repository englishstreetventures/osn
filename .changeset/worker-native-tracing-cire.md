---
"@cire/api": patch
"@cire/db": patch
"@cire/invites": patch
---

Update Wrangler and enable unredacted native traces in local and dev Cire Workers. Existing weddings stay on the untraced production guest Worker; new weddings route to a traced Worker with query redaction. Production API tracing remains off while its path-bearing spans are reviewed.
