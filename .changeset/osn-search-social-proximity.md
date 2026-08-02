---
"@shared/db-utils": minor
"@osn/api": minor
"@osn/client": patch
"@osn/social": minor
---

Rank OSN search on social proximity and name tokens, not text alone

`GET /recommendations/search` now follows the tiering Facebook's typeahead
describes — retrieve the caller's own graph first, then the global index, then
score the whole candidate set before slicing.

- **New retrieval pass over the caller's own edges.** An index seek on the
  connection indexes joined to `users`, capped at 50 rows. It is a recall
  guarantee, not a duplicate: every global pass is `ORDER BY handle LIMIT
  overfetch`, so a common prefix filled the window with whoever sorted
  alphabetically first and a connection could be missed entirely regardless of
  ranking. Organisation search gained the same pass over the caller's own
  memberships.
- **Ranking is text score + proximity score**, summed, computed before the page
  is sliced rather than after. Connections, then pending requests, then
  co-members of an organisation the caller belongs to, outrank strangers on the
  same text tier. Friends-of-friends is deliberately excluded: nothing exposes
  another profile's connection list, so ordering by mutuals would be the same
  graph-inference oracle that keeps `mutualCount` out of the payload.
- **Name-token prefix is now its own tier**, above handle infix. `"smith"` used
  to score `"Roberta Smith"` as a name infix — indistinguishable from
  `"Blacksmith Ltd"` and ranked below `@blacksmith`.
- **Multi-word queries work.** Tokens are matched independently, so
  `"Smith, John"` and `"smi joh"` both find `John Smith`, and the tokens are
  rejoined to spell the handle they imply, so `"john smith"` seeks `@johnsmith`
  on the index instead of skipping the seek on account of the space.
- **The minimum query length is 1**, down from 2. What a character reaches still
  widens in steps: 1 searches only the caller's own connections and
  organisations, 2 unlocks the global handle seek, 3 unlocks name matching.
- The three post-retrieval probes (blocks, connection state, shared
  organisations) now run concurrently, so the request has one fewer sequential
  database step than before despite the added signal.

`@shared/db-utils/search` gains `tokeniseQuery`, `joinTokens`,
`tokenContentLength` and `tokensPrefixName`. The tokeniser keeps every LIKE
metacharacter (`%`, `_`, `\`) inside the token, because `escapeLike` can only
neutralise a character that survives tokenisation — treating `%` as a separator
would turn `"a%b"` into `a` + `b` and convert the one wildcard the escape exists
to defuse back into a wildcard. Ordinary punctuation still splits, so
`"Smith, John"` tokenises the way a person reads it.

Two findings from the pre-merge security review, both introduced and fixed on
this branch:

- **S-M1** — the length gates compared the raw phrase, while the SQL they gate
  is built from the tokens. Since tokenisation drops separators, `"a."` reached
  a one-character global handle seek and `"a a"` a one-character global infix
  scan, bypassing the scope rule the 1-character floor depends on. The prefix
  pass now gates on the handle prefix actually bound into the range, and the
  infix pass on the longest token — an `AND` of `LIKE` patterns is only as
  selective as its most selective conjunct.
- **S-M2** — token count was unbounded. `q`'s 64-character cap admits 32
  single-character tokens, each emitting its own ANDed pair of `LIKE`
  predicates: 64 evaluations per scanned row on a conjunction that matches
  nothing, so `LIMIT` never short-circuits the scan. Capped at
  `MAX_QUERY_TOKENS = 6`.

The infix gate is **script-aware** (`hasScanworthyToken`). A minimum-length
gate is a proxy for a minimum-selectivity gate, and character count is only a
good proxy inside one alphabet: two Han characters pick a name out of a very
large space where two Latin letters barely narrow anything. Tokens in Han,
Hiragana, Katakana or Hangul therefore clear the gate at two characters. This
was a regression the token-length fix above introduced — `"日本 太郎"` is a
complete name whose every token is two characters, and a flat three-character
rule made it unsearchable.

No change to the response shape of either search surface.
