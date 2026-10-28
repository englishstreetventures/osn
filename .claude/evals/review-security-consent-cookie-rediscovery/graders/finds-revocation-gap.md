---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. Withdrawing consent for a category whose vendors have already loaded only stops further loading: the third party's executed globals, listeners, network access and cookies stay until the guest happens to reload.

PASS if the review carries a finding that revoking consent does not tear down what an earlier grant already loaded.

FAIL if the finding is absent or dismissed.

FAIL also if the file is missing or empty.
