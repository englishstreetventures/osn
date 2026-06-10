---
"@cire/api": minor
---

Organiser endpoints now require an OSN access JWT (validated against
the OSN JWKS via @shared/osn-auth-client). New
/api/organiser/weddings[/:weddingId/{guests,events}] routes scoped by
wedding ownership. X-Organiser-Token remains as belt-and-braces on the
import group until Phase 6 removes it.
