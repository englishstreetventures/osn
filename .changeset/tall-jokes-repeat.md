---
"@tools/pr-metrics": minor
---

Fix three defects that made the first real report misleading.

**An edit is not only an `Edit` call.** This repository's agent instructions tell agents to change files with `sed`, heredocs and short scripts rather than the dedicated tools, so counting only `Edit`/`Write` missed most edits. In the first 34 cards, 15 pull requests changed real source with zero `Edit` calls, and every one reported that 100% of its tokens went on exploration. Shell writes now count — `sed -i`, heredoc redirects, `tee`, `mv` — detected conservatively, since a false positive moves the boundary too early and under-reports exploration.

**An unobserved boundary is `null`, not 100%.** A session that never shows an edit now banks nothing, the card reports `tokens_before_first_edit: null`, and every ranking drops it; `sessions_with_observed_edit` says how many sessions contributed so a partial reading reads as partial. The old behaviour sorted the per-package ranking by which branches happened to avoid the Edit tool — `cire/host` appeared worst in the repository at 62% and reads 5% once fixed.

**Median, never mean.** Every per-pull-request distribution is right-skewed: across those 34 cards the median was 3.6M tokens, the mean 15.4M and the maximum 92.7M. The mean described the three largest pull requests and showed 8.5× month-over-month token growth where the median shows about 2×. Both the `report` command and `queries.sql` now use medians, and the column headings say so.
