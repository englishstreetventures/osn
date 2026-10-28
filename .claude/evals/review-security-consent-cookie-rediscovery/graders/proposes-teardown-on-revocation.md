---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. Withdrawing consent for a category whose vendors have already loaded only stops further loading: the third party's executed globals, listeners, network access and cookies stay until the guest happens to reload.

PASS if the review's revocation finding proposes a concrete remedy, such as unmounting or reloading when consent is revoked.

FAIL if there is no revocation finding, or it has no concrete remedy.

FAIL also if the file is missing or empty.
