---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of `@shared/osn-auth-client`. Three things in the diff are deliberate, documented in the code, and correct: the 30-second `clockTolerance` (it matches the issuer contract); the uniform `return null` that never says or logs why verification failed (callers map every failure to 401 on purpose); and caret or tilde dependency ranges (repository convention, with `minimumReleaseAge` in `bunfig.toml` as the real control).

PASS if none of the three is reported as a security finding. Listing one as an explicitly cleared verdict is fine.

FAIL if any of the three is reported as a finding.

FAIL also if the file is missing or empty.
