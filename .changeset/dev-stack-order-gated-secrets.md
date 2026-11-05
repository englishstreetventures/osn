---
"@shared/infra": patch
---

In each dev stack job, every step between the order check and the deploy that reads a secret runs only when the order check lets the commit deploy: the snapshot and the deploy, and in the musubi job the step that derives osn-api's cire seed values. `@shared/infra`'s workflow tests hold `deploy.yml` to that.
