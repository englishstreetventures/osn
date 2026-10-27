---
"@cire/api": patch
---

Every statement in the import write set now carries its own wedding scope. Updates and deletes name the wedding in their `WHERE` (through the household for guests, and through both the guest and the event for invitations), so another wedding's row matches nothing. A guest insert whose household is not the wedding's, and an invitation insert whose guest or event is not, fail as an insert naming a missing parent does. No statement is added.
