---
"@tools/e2e": patch
---

Harness tests and flow checks that could not fail now can. A prefixed id or a 43-character token whose random part has no digit is recorded as `:id`, so such a draw no longer changes `results.json`. The hub stand-in's keepalive is held equal to `@shared/realtime`'s, a crashed process's early exit is checked inside the test timeout, and the Stripe CLI's error line is checked present and redacted before its key is checked absent.
