---
"@cire/api": patch
"@cire/host": patch
---

Cap co-host seats, and show the owner who created each one.

A pre-merge security review broke the claim the editor-can-add design rests on.
`POST /hosts` had no cap while the list endpoint truncates at 200 rows, so an
editor could add 211 seats, have 200 listed, and leave 11 live co-hosts the
owner could neither see nor name in a `DELETE`. "Every addition an editor makes
is reversible by the one person who can't be removed" silently ran out.

`MAX_HOSTS_PER_WEDDING = 50` is now enforced in `hostsService.add` (409
`host_cap_reached`), sitting well below the now-named `LIST_CEILING = 200` so
"the list shows every seat" is a structural invariant rather than a coincidence.
`list()` also returns the true `total`, and the panel raises an alert when it
exceeds the rows shown — a wedding seeded above the ceiling before the cap
existed can no longer look complete.

Each row's `added_by_osn_profile_id` is surfaced to the owner (with the adder's
handle resolved alongside the co-host's), so a seat the owner did not create is
visible as such. Every seat reads the household claim codes and the dietary
export, so who created one matters.

The add and remove routes also move from per-IP to per-user rate limiting: with
the principal set widened from one owner to the owner plus every editor, an IP
bucket both under-protects and is shared unfairly between co-hosts behind one
NAT.
