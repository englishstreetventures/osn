#!/usr/bin/env bash
# Creates the label set on both issue repos. `--force` updates a label that
# already exists, so re-running this is how you fix a colour or a description.
set -euo pipefail

for repo in xchromo/osn xchromo/osn-tracker; do
  create() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force; }

  # Exactly one product label per issue -- the Project's "By product" view
  # groups on it, and the manifest gate rejects an issue carrying zero or two.
  create "product:osn-core" "1d76db" "OSN identity core"
  create "product:pulse" "0e8a16" "Pulse events"
  create "product:cire" "d93f0b" "Cire weddings"
  create "product:zap" "fbca04" "Zap chat"
  create "product:shared" "5319e7" "Shared packages and platform"
  create "product:landing" "c2e0c6" "Marketing sites"

  # At most one area label per issue. There is no `area:feature`: an issue with
  # no area is ordinary product work, and its type already says Feature. The
  # three finding areas exist on the public repo only so a mislabelled issue is
  # visible as a mistake; nothing should ever carry one there.
  create "area:security" "b60205" "Security finding"
  create "area:performance" "d4c5f9" "Performance finding"
  create "area:compliance" "006b75" "Compliance finding"
  create "area:ops" "bfd4f2" "Deploy, secrets, infrastructure"
  create "area:docs" "cccccc" "Documentation"
  create "area:schema" "f9d0c4" "Database schema and migrations"

  # Only findings carry a severity. It comes from the tier letter in the
  # finding ID, so it is never a judgement call at filing time.
  create "severity:critical" "b60205" "Blocks deploy"
  create "severity:high" "d93f0b" "Fix before next release"
  create "severity:medium" "fbca04" "Schedule into next sprint"
  create "severity:low" "0e8a16" "Opportunistic fix"
  create "severity:info" "ededed" "Informational"

  create "epic" "3e4b9e" "Parent issue with sub-issues"

  # Declared complexity, set before work starts and never after. It is the
  # denominator every session-metrics query divides spend by, so a rating made
  # once the token cost is on screen gets talked into agreeing with it and the
  # metric stops questioning anything. Fibonacci so that cost ÷ complexity is a
  # real division, and it rates the *problem*: a one-line fix to a race
  # condition is not a 1. `/new-feat` applies one through the rate-complexity
  # skill; see wiki/observability/session-metrics.md.
  create "complexity:1" "0e8a16" "One file, no new behaviour"
  create "complexity:2" "7ed321" "One package, an existing pattern followed"
  create "complexity:3" "fbca04" "One package, something must be designed"
  create "complexity:5" "d93f0b" "Several packages, or a contract others depend on"
  create "complexity:8" "b60205" "Cross-cutting, or the shape is unknown at the start"

  # Not a rating — a caveat on one. An agent rated this and no human signed
  # off, which is most of the backfill over issues that predate the label.
  # Exclude these from any query you intend to act on.
  create "complexity:unconfirmed" "bfbfbf" "An agent's rating that no human signed off on"

  # Orthogonal to every label above: a state, not a category. An agent working
  # the backlog applies it when the next step needs a choice only the repo
  # owner can make, writes the choice up in the body, and moves to another
  # issue rather than guessing. Its own colour, because sharing the security
  # red would make a parked question look like a critical finding.
  create "needs:decision" "e99695" "Blocked on a decision from the repo owner; do not action without one"
done
