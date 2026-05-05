Audit dependency versions across all workspaces for drift and risk.

---

## Step 1 — Collect versions

For each workspace (apps/web, apps/api, packages/db, root):
1. Read package.json
2. List all dependencies and devDependencies with current version ranges

---

## Step 2 — Check for updates

For key dependencies, check latest version:
- Run `bun outdated` in each workspace directory, or
- Use `npm view <package> version` for specific packages

---

## Step 3 — Analyse

For each outdated dependency:
- Current version vs latest
- Bump type: patch / minor / major
- Risk: low (patch) / medium (minor, check changelog) / high (major, breaking changes likely)
- Note if the package has known security advisories

---

## Step 4 — Report

| Package | Workspace | Current | Latest | Bump | Risk |
|---------|-----------|---------|--------|------|------|
| ... | ... | ... | ... | ... | ... |

Group by risk level (high → medium → low).

Notes:
- Caret/tilde ranges are intentional convention — don't flag range style
- Don't flag bun itself or root-only devDependencies unless security issue
- If all dependencies are current, state: "All dependencies up to date."
