---
"@osn/api": patch
---

Close org privilege-escalation via add/remove and gate the member roster.

The owner-only role gate (`updateMemberRole`) was bypassable: `addMember` let
any admin insert a target as `admin`, and `removeMember` let any admin remove
other admins — so an admin could mint or strip admins via remove+add. Granting
`admin` now requires the owner, and removing an admin now requires the owner;
admins may still add and remove plain members.

`GET /:handle/members` returned the full roster (handles, display names, roles)
to any authenticated user with no membership check. It is now restricted to
members of the org. If public org pages are desired later, gate on an explicit
`organisations.visibility` flag rather than dropping the check.
