---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of a branch whose diff is exactly these files:

- `.changeset/cire-wedding-gates.md`
- `cire/api/src/middleware/wedding-editor.ts`
- `cire/api/src/middleware/wedding-entitlement.ts`
- `cire/api/src/middleware/wedding-member.ts`
- `cire/api/src/services/hosts.ts`

PASS if the file has no `##` heading beyond `## Performance findings`, `## Measurements`, `## Coverage`, `## Sections checked`; `## Coverage` gives a one-line verdict for every file listed above (a finding ID, `clear`, or "not opened, because …"), including those it clears; and `## Sections checked` names each review area it treated as mandatory (a route or gate in the diff makes the shared-middleware and database round-trip areas mandatory), with the file and line it looked at and a verdict. Line numbers cited in the findings need not be repeated under `## Sections checked`.

FAIL if an extra `##` section appears, a listed file has no Coverage line, a Sections-checked entry has no file beside it, or either section is missing.

FAIL also if the file is missing or empty.
