# A filed finding, end to end

Reference for `prep-pr` Step 7. The four fields are Issue / Why / Solution / Rationale, in that order.

```bash
gh issue create --repo xchromo/osn-tracker \
  --title "S-M1 — No rate limit on POST /events/:id/rsvp" \
  --type Bug \
  --label "area:security" --label "severity:medium" --label "product:cire" \
  --body "$(cat <<'EOF'
**Issue:** `cire/api/src/routes/rsvp.ts:42` — `POST /events/:id/rsvp` has no
rate limit. Every sibling write route calls `rateLimit()` first; this one does not.

**Why:** The route is reachable unauthenticated with a guest claim token, so a
single token can enumerate event IDs and write an RSVP per request. It also writes
a row per call, so the cost lands on D1.

**Solution:** Wrap the handler in `rateLimit({ key: "rsvp", limit: 10, window: "1m" })`
from `@shared/rate-limit`, keyed on the claim token rather than the IP.

**Rationale:** Matches the limiter every other write route already uses, so there is
no new mechanism to maintain. Keying on the token, not the IP, is what stops one
token behind a shared NAT from locking out a whole venue's guests.

Found reviewing `<branch-name>`.
EOF
)"
```
