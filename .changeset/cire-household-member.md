---
"@cire/api": patch
"@cire/db": patch
"@cire/invites": patch
---

Household member identity, behind `cire.account-linking`: after a claim the guest box asks "Who are you?", each reply and change-log row records the member who sent it ("Answered by"), and the musubi link binds to that member and shows the signed-in account's picture and handle with "Not you?". Migration 0075 adds `sessions.member_guest_id`, `rsvps.submitted_by_guest_id`, `rsvps.submitted_via_link` and `rsvp_changes.actor_guest_id`.
