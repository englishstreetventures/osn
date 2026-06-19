---
"@cire/api": patch
"@cire/web": patch
---

Polish family claim codes — long codes are enterable, surnames are cleaner, and
the middle word is wholesome.

- `@cire/web`: the guest claim input had `maxLength={30}`, which truncated longer
  secure codes (e.g. `THENGUYENFAMILY-BANISTER-DM65HQ`, 31 chars). Raised to 48,
  comfortably above the worst-case code length (SURNAME 16 + word 10 + grouped
  secure hash 11 + two dashes = 39). Trim + upper-case normalisation unchanged;
  the server still validates.
- `@cire/api`: `normaliseSurname` now strips common filler tokens (THE, A, AN,
  AND, FAMILY, FAMILIES, HOUSEHOLD, OF, &) before collapsing, so
  "The Nguyen Family" → `NGUYEN`, "Smith & Jones" → `SMITHJONES`,
  "The Patels" → `PATELS`. The 16-char cap and `"" → FAMILY` fallback are kept.
- `@cire/api`: the WORD segment now draws from a curated, wedding-appropriate
  word bank (`data/pleasant-wordlist.ts`, 369 words across flowers, trees,
  fruits, birds, gentle animals, gemstones, celestial/sky, colours, and soft
  nature words) instead of the EFF short wordlist, which contained words that
  read poorly on an invite (the owner spotted "bruise"). The EFF module is
  removed. Entropy: WORD drops from ~10.34 to ~8.53 bits; the HASH still carries
  the bulk (50 bits secure / 30 bits simple), so totals stay ≈ 58.5 bits (secure)
  / 38.5 bits (simple) — well above any guessing threshold.

Ops note: only NEWLY minted/reminted codes change. Existing stored
`families.public_id` values are untouched, so live codes keep working — the input
fix makes the current long Nguyen code enterable immediately, and the owner can
remint that family to get a clean `NGUYEN-…` code.
