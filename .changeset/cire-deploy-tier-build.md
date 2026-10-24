---
"@cire/build-tools": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
---

A deploy build of the guest site, the organiser portal or the vendor portal fails when the cire-api URL it resolves is on a loopback host (`localhost`, `*.localhost`, `127.0.0.1`), over https as well as http, when its tier is neither `dev` nor `production`, and, on `production`, when the URL is not `https://api.cireweddings.com`. A deploy build is one whose environment sets `OSN_DEPLOY_TIER` at all, an empty value included; the three sites' build steps in `deploy.yml` set `dev` and those in `production-release.yml` set `production`, and turbo hashes it into every build, so a deploy build never replays a cached build made without it. Local builds and CI's test builds set no tier and still fall back to the local cire-api. Each tier-headers test suite clears the tier first, so a shell that exports it changes no result.
