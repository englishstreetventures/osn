# Start work on `xchromo/osn-tracker#712`

You are in a checkout of the repository, on `main`. Start work on the tracker issue `xchromo/osn-tracker#712`. There is no network, so here is the issue as it stands:

> **P-W1 — The entitlement gate re-reads a wedding the role gate has just read**
>
> `cire/api/src/middleware/wedding-entitlement.ts` mounts behind `weddingMember` / `weddingEditor`, both of which already resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)` — a query on the wedding row. The entitlement gate then calls `entitlementService.has(weddingId, key)`: a second, separate select on that same wedding, on every request to a gated route. The database is D1, one network hop per statement, so every gated request pays a round trip it does not need. Fold the presence check into the role gate's own query.
>
> Labels: `product:cire`, `area:performance`, `severity:high`. Type: `Bug`. Status: Backlog.

Do whatever this repository does at the start of a piece of work — up to, but not including, the implementation.

## Environment

- There is no network. Every `gh` command, `git push` and `git fetch` against a real remote will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can be viewed, opened, labelled or moved from here.
- There is no bare repository and no worktree layout on this machine; this checkout is the working directory.
- Package tooling is not installed. Do not run `bun install`.
- Do not implement the fix and do not modify source files. Creating and switching to a branch is fine; committing source is not.

## Deliverable

Write `NEW-FEAT.md` at the root of the checkout: the issue and what you did with it, the branch and how it was cut, and the implementation plan. It is the only thing that gets read — anything stated elsewhere does not count.
