---
---

cire/api: host list resolves OSN profileId → handle live via the batch graph endpoint (`POST /graph/internal/profile-displays`, ARC `graph:read`). `GET /api/organiser/weddings/:weddingId/hosts` now carries `{ handle, displayName }` per co-host, merged from a single batch lookup; the profile id stays only as the last-resort display fallback (no handle is denormalised into `wedding_hosts`). The resolver is key-optional + fail-soft: an absent/malformed ARC key or an unreachable osn-api degrades the list to profile ids rather than erroring.
