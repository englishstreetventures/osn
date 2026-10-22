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

Guests can have an email address, each tagged with who supplied it and the consent behind it, and stored trimmed, lower-cased and in printable ASCII only, so one mailbox has one stored form. On the invite, the member a household says is answering can add, change or remove their own address after ticking a consent box, and the save button says what is missing until both are there; removing an address, or replacing one the hosts added, puts it on the wedding's suppression list, which only that seat can clear. In the organiser portal, owners and editors add or change addresses in the guest editor or a spreadsheet's optional `Guest Email` column, and applying such a change asks them to confirm each guest agreed and to pass on the guest privacy notice; an apply whose addresses, or the guests' withdrawals among them, differ from what its preview showed is refused for a fresh preview. A host cannot change an address a guest gave themselves, only remove it; a spreadsheet or revert never touches one, and a revert never restores an address a guest withdrew. The guest list shows each address, who added it and any opt-out. Migration `20261022145310_guest_emails` adds the columns and the `email_suppressions` table, which the yearly guest-data sweep and the wedding purge delete with the rest. Both privacy notices describe the new data. No email is sent yet.
