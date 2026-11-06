---
"@shared/infra": patch
---

A stack for the domain move rehearsal (`rehearsal/alchemy.run.ts`): one marker Worker at the `domain-move` stage of the dev account, on the spare host `next.domain-move.<DEV_DOMAIN>` or the moved host `domain-move.<DEV_DOMAIN>` as `REHEARSAL_MODE` says, run by the new `rehearsal:deploy` and `rehearsal:destroy` scripts. `rehearsal/names.ts` holds the rehearsal's hosts, Worker and per-run Pages project names, and refuses a production zone. `requiredCredentials("dev")` and `knownCredentials()` gain `CLOUDFLARE_DEV_PAGES_DNS_TOKEN` and `CLOUDFLARE_DEV_PAGES_UPLOAD_TOKEN`, so `secrets:check-github` requires both in the dev Environment and forbids both in production.
