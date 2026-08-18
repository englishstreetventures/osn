# Tracker templates

These files are **not used by this repo.** They belong to `xchromo/osn-tracker`, the private
repo that holds every security, performance, and compliance finding.

They are kept here so the form lives under review with the rest of the workflow, and so a
change to the finding format lands in one PR rather than two. The tracker holds only issues —
no code, no history worth reviewing — so it is a poor home for the source of truth.

Install them into the tracker whenever this directory changes:

```bash
gh api repos/xchromo/osn-tracker/contents/.github/ISSUE_TEMPLATE/review-finding.yml \
  -X PUT -f message="chore: sync the review-finding form" \
  -f content="$(base64 -i .github/tracker/ISSUE_TEMPLATE/review-finding.yml)" \
  -f sha="$(gh api repos/xchromo/osn-tracker/contents/.github/ISSUE_TEMPLATE/review-finding.yml --jq .sha 2>/dev/null)"
```

Drop the `-f sha=` line on the first install — it is only needed to overwrite an existing file.

**Nothing in `.github/tracker/` may contain finding text.** This repo is public. The form is a
blank shape; the findings that fill it stay in the tracker.
