---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

Unlock codes: the platform owner mints a code that moves a wedding to Gold or Crimson with no payment, and any owner of the wedding redeems it from Settings.

`bun run --cwd cire/api mint-unlock-code --tier gold --by <operator> [--uses N] [--expires YYYY-MM-DD]` prints the code and the SQL row to apply; the row holds only the code's SHA-256. `POST /api/organiser/weddings/:weddingId/unlock-code` is owner-only and limited to five tries a minute per organiser. It checks the code, its expiry and its remaining uses and raises the tier in one D1 batch, so two weddings racing for a code's last use cannot both win. A code never lowers or repeats a tier, and is held back while an upgrade checkout for the wedding can still be paid. An unknown, expired or used-up code all get the same 404.

Migration 0082 adds `unlock_codes` and `unlock_code_redemptions`; `weddings.tier_source` gains `code`.
