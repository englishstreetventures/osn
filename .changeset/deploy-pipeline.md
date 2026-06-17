---
---

Add a production deploy GitHub Actions workflow (`.github/workflows/deploy.yml`): gated on a build/test job, applies remote cire D1 migrations then deploys the cire-api Worker and the cire-web Pages project. CI-only; no package version impact.
