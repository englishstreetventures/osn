---
---

Infra-config + docs only: move all four D1 databases (cire-db + osn-db
dev/staging/prod) from WEUR to **`oc` (Oceania / Sydney)** — the WEUR databases were
deleted and recreated, with the new `database_id` UUIDs rewired across
`cire/api/wrangler.toml`, `osn/api/wrangler.toml`, `.github/workflows/deploy.yml`, and
the deploy/runbook docs. Also locks the **Upstash Redis region to `ap-southeast-2`
(Sydney)**, resolving the previously-pending C-M18 compliance decision — co-located with
the D1s + Australian edge traffic for low RSVP/auth-write latency (the project is
AU-centric). No workspace package behaviour changes (wrangler.toml is deploy config).
Subprocessor register, TODO Compliance Backlog (C-M18 closed), compliance-fixes
changelog, the production-deploy runbook, and the redis / database-environments system
pages updated to record both regions.
