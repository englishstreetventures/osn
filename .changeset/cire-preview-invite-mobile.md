---
---

Fix the organiser "Preview invite" button on mobile: open the new tab
synchronously inside the click gesture (before the `/preview-code` fetch) so
mobile browsers no longer block it as a non-user-initiated popup. The blank tab
is navigated to the guest preview once the host code returns, closed on any
failure (never orphaned), and falls back to a same-tab navigation when popups
are unavailable. `noopener` is kept in the `window.open` features argument and
`opener` is nulled after navigation.
