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
done
