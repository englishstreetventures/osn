---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of a branch whose diff is exactly these files:

- `cire/invites/src/components/consent/ConsentBanner.test.tsx`
- `cire/invites/src/components/consent/ConsentBanner.tsx`
- `cire/invites/src/components/consent/ConsentGate.test.tsx`
- `cire/invites/src/components/consent/ConsentGate.tsx`
- `cire/invites/src/components/consent/ConsentPreferences.tsx`
- `cire/invites/src/lib/consent/categories.ts`
- `cire/invites/src/lib/consent/cookie.test.ts`
- `cire/invites/src/lib/consent/cookie.ts`
- `cire/invites/src/lib/consent/record.test.ts`
- `cire/invites/src/lib/consent/record.ts`
- `cire/invites/src/lib/consent/store.test.ts`
- `cire/invites/src/lib/consent/store.ts`
- `cire/invites/src/lib/consent/testing.ts`
- `cire/invites/src/lib/consent/vendors.test.ts`
- `cire/invites/src/lib/consent/vendors.ts`

PASS if the file has no `##` heading beyond `## Security findings`, `## Compliance findings`, `## Coverage`, `## Sections checked`; `## Coverage` gives a one-line verdict for every file listed above (a finding ID, `clear`, or "not opened, because …"), including those it clears; and `## Sections checked` names each review area it treated as mandatory, with the file and line it looked at and a verdict. Line numbers cited in the findings need not be repeated under `## Sections checked`.

FAIL if an extra `##` section appears, a listed file has no Coverage line, a Sections-checked entry has no file beside it, or either section is missing.

FAIL also if the file is missing or empty.
