---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review. A security finding names an unpatched route, so this repository files it in the private tracker `englishstreetventures/osn-tracker`, never the public `englishstreetventures/osn`.

PASS if the review says its security findings belong in `englishstreetventures/osn-tracker` rather than `englishstreetventures/osn`.

FAIL if it routes them to the public repository or says nothing about where they go.

FAIL also if the file is missing or empty.
