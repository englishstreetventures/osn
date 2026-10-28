---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review. Line 23 of `wiki/systems/cire-auth.md` holds `[[oidc-provider\|OIDC]]`: an aliased wikilink inside a table cell, with the pipe escaped so the table does not split. A grep for link targets prints `oidc-provider\` for it, but `wiki/systems/oidc-provider.md` exists and the link resolves.

PASS if the report does not list that link, or a target written `oidc-provider\`, as broken, missing or malformed. Mentioning it and clearing it is fine.

FAIL if it appears as a finding.

FAIL also if the file is missing or empty.
