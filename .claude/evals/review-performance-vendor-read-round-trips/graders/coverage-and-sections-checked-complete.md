---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of a branch whose diff is exactly these files:

- `.changeset/vendor-enquiries-and-directory.md`
- `cire/api/src/routes/vendor-enquiries.ts`
- `cire/api/src/services/directory.ts`
- `cire/vendor/src/components/ClaimApp.tsx`
- `cire/vendor/src/components/ListingEditor.tsx`

PASS if the file has no `##` heading beyond `## Performance findings`, `## Measurements`, `## Coverage`, `## Sections checked`; `## Coverage` gives a one-line verdict for every file listed above (a finding ID, `clear`, or "not opened, because …"), including those it clears; and `## Sections checked` names each review area it treated as mandatory, with the file and line it looked at and a verdict. Line numbers cited in the findings need not be repeated under `## Sections checked`.

FAIL if an extra `##` section appears, a listed file has no Coverage line, a Sections-checked entry has no file beside it, or either section is missing.

FAIL also if the file is missing or empty.
