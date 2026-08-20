---
"@osn/api": patch
---

Drop the duplicate session SELECT in the token-refresh path: `verifyRefreshToken` now returns the device metadata from the row it already loaded, and `refreshTokens` carries it onto the rotated-in row instead of re-reading the same session by primary key.
