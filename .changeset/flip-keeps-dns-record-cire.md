---
"@cire/infra": patch
---

The cire stack's deploy runs through the patched Alchemy provider, whose Worker custom-domain attach can replace a flip host's CNAME to its own Pages project in one request, when the release names it in `OSN_WORKER_DOMAIN_REPLACE_CNAME`. A flip of a cire site now keeps a DNS record for its host from the detach to the attach.
