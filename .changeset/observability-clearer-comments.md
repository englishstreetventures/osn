---
"@shared/observability": patch
---

The Elysia plugin's hooks now run for the app that mounts it, so each request's server span ends, its HTTP metrics are recorded, and the in-flight gauge falls when the request finishes. A request's error span records the error's name and Elysia's error code, never its message or stack. Comments in the config loader, the plugin and the health routes now state what the code guarantees.
