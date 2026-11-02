---
"@musubi/social": patch
"@pulse/web": patch
"@shared/ui": patch
---

Move `playwright` from 1.62.1 to 1.64.1. The browser-test tier now runs on
Chromium 156.0.8078.4 (revision 1248), the same build the E2E suite drives.
