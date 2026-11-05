---
title: Feature Observability Checklist
aliases: [observability checklist, new feature checklist]
tags: [observability, checklist, convention]
status: active
related:
  - "[[overview]]"
  - "[[logging]]"
  - "[[tracing]]"
  - "[[metrics]]"
  - "[[contributing]]"
last-reviewed: 2026-11-05
---

# Feature Observability Checklist

Every feature PR should answer these questions before merge.

## Checklist

- [ ] **Logs** -- are all error paths covered by `Effect.logError` with the tagged error? Any `console.*` calls? Any secret fields that need adding to the redaction deny-list?
  - See [[logging]] for the full log level guide, redaction rules, and route-level logger wiring pattern.

- [ ] **Traces** -- is every service function wrapped in `Effect.withSpan("<domain>.<operation>")`? Are the span names consistent with existing ones, under 64 bytes, and are their attributes free of PII? On a Worker they land in Cloudflare's trace beside its own D1 and `fetch` spans.
  - See [[tracing]] for span naming conventions and what a Workers trace carries.

- [ ] **Metrics** -- does this feature need new counters/histograms? If yes, added to the correct `metrics.ts` file with typed `Attrs`? Names follow `{namespace}.{domain}.{subject}.{measurement}`? Cardinality bounded? (None reaches an exporter yet: englishstreetventures/osn#501.)
  - See [[metrics]] for the naming convention, single-definition-site rule, and per-metric attribute rules.

- [ ] **Dashboards / alerts** -- if this is a critical path (auth, payments, S2S, messaging), is there a follow-up task to add a dashboard row or alert rule? (Out of scope for most feature PRs but worth noting.)
