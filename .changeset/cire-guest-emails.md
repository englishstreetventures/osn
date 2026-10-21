---
"@cire/api": patch
"@cire/db": patch
"@cire/guest-email": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@tools/e2e": patch
---

Guests can have an email address, each tagged with who supplied it and the consent behind it. On the invite, the member a household says is answering can add, change or remove their own address after ticking a consent box; removing it puts the address on the wedding's suppression list, which only that seat can clear. In the organiser portal, owners and editors add or change addresses in the guest editor or a spreadsheet's optional `Guest Email` column, and applying such a change asks them to confirm each guest agreed and to pass on the guest privacy notice. A host cannot change an address a guest gave themselves, only remove it; a spreadsheet or revert never touches one, and a revert never restores an address a guest withdrew. The guest list shows each address, who added it and any opt-out. Migration 0092 adds the columns and the `email_suppressions` table, which the yearly guest-data sweep and the wedding purge delete with the rest. Both privacy notices describe the new data. No email is sent yet.
