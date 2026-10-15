---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
---

Update Wrangler and enable native tracing on the Cire guest Worker. Production traces redact query strings; existing path-based guest links remain supported, and newly generated links use fixed routes with slugs in the query. Production API tracing remains off while its path-bearing spans are reviewed.
