---
"@tools/pr-metrics": minor
---

Read the declared complexity rating off an issue's labels.

`declaredFromLabels` turns a `complexity:` label into `complexity.declared` on the card, and marks it `unconfirmed` when `complexity:unconfirmed` is also present. The CLI resolves it from `--issue-labels`, so whatever `prep-pr` reads off the issue carries the rating with it and nobody retypes a number the issue already holds. `--complexity` stays as an override for a branch with no issue and is recorded as `manual`, so a hand-typed rating never sits in a query beside one an owner confirmed.

A rating outside the 1/2/3/5/8 scale, or two rating labels on one issue, reads as unrated — both are labelling mistakes, and surfacing them beats averaging them away.
