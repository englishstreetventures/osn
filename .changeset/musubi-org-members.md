---
"@osn/client": minor
"@musubi/social": patch
---

The organisations client matches osn-api's organisation routes. `OrgSummary` drops `id` and `ownerId`, and `OrgMember` is the flat roster row `{ handle, displayName, role, joinedAt }`. `getOrg` returns `{ organisation }`, and `createOrg` and `updateOrg` return `{ ok, organisation }`, as their routes send them. Every method takes an organisation handle and, for a member, a profile handle; `addMember` posts to `/organisations/:handle/members/:profileHandle` with `{ role }`. `OrgClientError` carries the response's HTTP `status`. A contract test holds the client to `shared/openapi/osn.json`.

Musubi's organisation page opens again at `/organisations/:handle`: it reads the organisation from `getOrg`'s body, lists members by handle with initials (the roster carries no avatar), removes a member by handle, and says "Organisation not found." for a missing organisation and "Only members can see who belongs to this organisation." when the roster is refused, where it used to fail to render.
