---
"@cire/infra": patch
---

The cire stack's `REALTIME_HUB` binding now says what removing it does: Alchemy asks Cloudflare to delete the `TopicHub` class on the first deploy in which no binding names it, so removing the entry is not how realtime push turns off. The steps for each tier are in `wiki/cire/cire.md`, "Turning realtime push off". No behaviour change.
