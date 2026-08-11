---
"@osn/api": patch
---

Organisation route group — response schemas and stable operation ids (PR 6 of
the `shared/openapi/osn.json` series). All nine routes in
`routes/organisation.ts` — create, list mine, read, update, delete, add member,
remove member, change role, list members — previously generated with an empty
`responses` object. Nine of the eighteen remaining empty operations; the last
nine are account erasure/export, profiles and recommendations.

Two consts in `routes/response-schemas.ts` were named after the graph but are
not specific to it, so they are renamed rather than duplicated per group:
`graphErrorResponse` → `errorResponse` and `graphOkResponse` → `okResponse`.
Both are internal to `osn/api` and the generated spec is unchanged by the
rename. Four groups still to come would each have needed its own copy.

Points where the described behaviour is not what the endpoint looks like:

- **`POST /organisations/` cannot 500.** Its catch maps every service failure
  to 400, so a taken handle and a database fault are reported identically. The
  schema says so rather than declaring a 500 that never arrives.
- **Authorisation refusals are 400, not 403,** everywhere a check lives in the
  service: "only admins can update", "only the owner can delete", "only the
  owner can grant admin". The single real 403 is `GET
  /organisations/:handle/members`, whose membership check runs in the route.
- **404 on the member routes covers two different misses** — no such
  organisation and no such profile — told apart by the message, since both
  handles are in the path.
- `resolveOrg` sets **500** when the lookup itself throws and returns null
  either way, so every handle-resolving route can emit a 500 carrying the same
  `{ error: "Organisation not found" }` body.

One behaviour change, and it is a fix: in `GET /organisations/:handle/members`
the `getMemberRole` call sat outside the `try`, so a database fault during the
membership check escaped to Elysia's default handler and answered with a body
unlike every other error in the group. It now runs inside the `try` and reports
`{ error }` at 500 like its neighbours. The 200 and 403 paths are untouched.

`listMembers` also had its return type narrowed from `role: string` to the
column's own `"admin" | "member"`. The roster is what a client reads before
PATCHing a role back, and both request bodies accept exactly those two values,
so the wider type was wrong at the source — and a `t.String()` in the response
schema would have propagated it into every generated client.

Route set unchanged: 62 paths, 73 operations before and after.
`shared/openapi/pulse.json` regenerates byte-identical.
