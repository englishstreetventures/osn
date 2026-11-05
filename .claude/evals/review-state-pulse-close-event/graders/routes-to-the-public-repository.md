---
type: llm
weight: 0.5
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a correctness defect in a state transition. In this repository such a finding is public: it is fixed on the branch, and one left open is filed in `englishstreetventures/osn`, not in the private tracker `englishstreetventures/osn-tracker`, which holds security, performance and compliance findings.

PASS if the review says its state findings belong in the public `englishstreetventures/osn` (or are fixed on the branch and, if left open, filed there) rather than in the tracker.

FAIL if it routes the state finding to `englishstreetventures/osn-tracker`, or says nothing about where it goes.

FAIL also if the file is missing or empty.
