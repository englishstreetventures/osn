---
"@pulse/app": patch
---

Pulse: replace `csp: null` in `tauri.conf.json` with a strict Content-Security-Policy allowlist. `connect-src` permits Tauri IPC, `photon.komoot.io` (geocoding) and the local OSN/Pulse API ports; `img-src` permits `*.tile.openstreetmap.org` for Leaflet tiles. Closes S-L3.
