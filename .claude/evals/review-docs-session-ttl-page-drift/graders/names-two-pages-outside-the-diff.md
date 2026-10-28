---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review of a branch that cuts the guest cookie's lifetime from 30 days to 14. Three pages outside the diff still say 30 days: `wiki/compliance/retention.md` line 52, `wiki/compliance/data-map.md` line 126, and `wiki/compliance/dpia/cire-guest-data.md` lines 181 and 211. Where the report puts them, as findings or as suggested next sweeps, does not matter.

PASS if the report names at least two of those pages by repository path as stale as of this branch.

FAIL if it names fewer than two.

FAIL also if the file is missing or empty.
