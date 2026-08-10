---
"@osn/api": patch
---

Graph route group — response schemas and stable operation ids (PR 5 of the
`shared/openapi/osn.json` series). All eleven user-facing routes in
`routes/graph.ts` — connection request, respond, remove, the three connection
lists, connection status, block, unblock, block list and the block check —
previously generated with an empty `responses` object, and so a `Void` return
in any generated client. Each now describes every status it can emit.

The schemas live in a new `routes/response-schemas.ts`, deliberately separate
from `routes/auth/response-schemas.ts`. The two groups do not share an error
envelope: the auth surface funnels failures through `publicError`, whose body
carries an optional human-readable `message` alongside `error`, while these
routes answer with a bare `{ error }` whose value already IS the message —
either a fixed string ("Unauthorized", "Profile not found", "Too many
requests") or `makeSafeError`'s output. A single shared const would have had to
be a superset of both, documenting a `message` field that half the API never
sends.

Each status set is taken from the handler's literal control flow rather than
from what the endpoint looks like it should do. Three consequences worth
naming:

- The three list endpoints and `GET /blocks` declare only 200/401/500. They are
  reads, so no rate limiter runs, and they take no handle, so nothing can 404.
- Both mutations that create a row (`POST /connections/:handle`,
  `POST /blocks/:handle`) answer 201; every other mutation answers 200.
- "Not connected", "no pending request" and "no block to remove" are all 400,
  not 404. The profile in the path exists in each case — it is the edge that
  doesn't, and `resolveHandle` is what owns 404.

`resolveHandle` also sets **500** when the lookup itself throws, returning null
either way, so every route that resolves a handle can emit a 500 carrying the
same `{ error: "Profile not found" }` shape. That is why 500 is declared with
the error envelope throughout rather than left off the read paths.

`getConnectionStatus` returns a closed union (`none` / `pending_sent` /
`pending_received` / `connected`) rather than a plain string, matching the
service's own return type, so a generated client gets an enum it can switch
over. It is directional on purpose: a client can label the button "Cancel" or
"Accept" without a second call.

No behaviour change: the route set in `shared/openapi/osn.json` is identical
before and after (62 paths, 73 operations), and `shared/openapi/pulse.json`
regenerates byte-identical.
