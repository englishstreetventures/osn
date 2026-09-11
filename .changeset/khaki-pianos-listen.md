---
"@tools/pr-metrics": patch
---

Keep every block of a split API response. One response reaches the transcript as
several records — a thinking block, a text block, one per `tool_use` — sharing a
`requestId`, and the record dedupe keyed on that, so it kept the first block and
dropped the rest. On one branch here it lost all four `Agent` dispatches and 321
of 450 `Bash` calls, and the card then reported no subagents at all. Records now
dedupe on `uuid`, which is what a cross-file duplicate actually repeats, and the
two readers of `message.usage` count each `requestId` once so the cost a card
reports does not move.
