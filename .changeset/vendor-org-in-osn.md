---
---

cire vendor portal: remove organisation *creation* from the portal — an org is an OSN account-level entity, so the portal now only lists the caller's OSN orgs and shows an empty-state directing vendors to create one in their OSN account. Drops the create-org form + `createOrg` client. No cire package version bump (unversioned). (Follow-up: deploy an OSN org surface + turn the empty-state into a link.)
