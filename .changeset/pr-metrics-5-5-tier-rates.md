---
"@tools/pr-metrics": patch
---

Price Claude Sonnet 5.5 at $2 input and $10 output per million tokens, and Claude Haiku 5.5 at $0.10 and $0.50. Without the entries, every card's tokens on either model counted as $0 towards `usd_equivalent`, and the collector warned `no rate for claude-haiku-5-5`.
