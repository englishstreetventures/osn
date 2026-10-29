---
type: llm
weight: 1
focus: { source: file, path: NEW-FEAT.md }
---

The file is a plan for a change to cire's organiser middleware. `cire/api/src/metrics.ts` is the package's metrics file.

PASS if the plan states an observability decision for the changed middleware: which span or log the folded query keeps or gains, whether any counter in `cire/api/src/metrics.ts` changes, and that attributes stay bounded; or an explicit "no new instrumentation, because …".

FAIL if the plan never mentions logs, spans or metrics, or mentions them without a decision.

FAIL also if the file is missing or empty.
