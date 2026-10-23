---
"@tools/pr-metrics": patch
---

`queries.sql` runs again under DuckDB 2.0. Its `cards` view now declares the card's shape instead of inferring it, with the five objects a card keys by data (`spend.by_model`, `spend.effort`, `interaction.tool_calls`, `interaction.skills`, `interaction.subagents`) read as maps, so a card holding two names that differ only in case (`Bash` and `bash`) no longer stops the script. The nine queries return the same rows over the committed cards. A new test fails when the declared shape and the card the collector writes disagree, and the DuckDB tests now turn off DuckDB's agent mode, which had hidden the error from them.
