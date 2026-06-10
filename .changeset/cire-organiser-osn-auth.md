---
"@cire/organiser": minor
---

Organiser portal sign-in switched from the X-Organiser-Token shared
secret to OSN passkey login (@osn/client + @osn/ui SignIn). All cire
API calls now carry the OSN access JWT via authFetch; guest/event
views moved to the wedding-scoped endpoints.
