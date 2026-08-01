---
"@osn/api": patch
"@pulse/api": patch
---

Allow the Pulse iOS webview origin (`tauri://localhost`) through CORS and the
Origin guard in local and dev environments. A literal `null` origin stays
rejected.
