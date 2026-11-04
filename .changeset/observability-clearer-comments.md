---
"@shared/observability": patch
"@osn/api": patch
---

The Elysia plugin's hooks now run for the app that mounts it, so each request's server span ends, its HTTP metrics are recorded, and the in-flight gauge falls when the request finishes. A request's error span records the error's name and Elysia's error code, never its message or stack; the server span names the matched route template and carries no URL path; and the `http.request.method` metric attribute is one of the standard methods or `_OTHER`. Comments in the config loader, the plugin, the health routes and osn-api's app factory now state what the code guarantees.
