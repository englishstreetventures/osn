---
"@cire/host": patch
"@tools/e2e": patch
---

An old-style `#/weddings/<id>/<tab>` dashboard link resolves its tab name only
to one of the seven legacy tabs; any other name opens the wedding's default
module.

Returning to a hidden organiser tab reads the wedding list once. When the
socket the hidden tab closed reopens within a second of the tab being shown,
its reconnect relies on the list read the return started: it sends none once
that read has landed, waits on it while it is in flight, and reads only if no
read started since the show lands. A slower reopening still reads again.

The `cire-checklist-starter` E2E flow ends by hiding its page until the
socket closes and showing it again, and checks the return reads the list once.
