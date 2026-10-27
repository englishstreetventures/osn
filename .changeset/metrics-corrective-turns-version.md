---
"@tools/metrics": patch
---

The corrective-turn chart reads only cards from schema version 4 on, where the count is the prompts sent while the agent was still working. An older card counted every turn after the first tool call, so its rate is left out as unknown and counted in the chart's note.
