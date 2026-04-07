Audit all dependencies across the monorepo for version drift and staleness. Today's date is available in CLAUDE.md context (`currentDate`). Use it for all date comparisons.

---

## Step 1 — Collect all dependencies

Read every `package.json` in the repo (excluding `node_modules`). You can find them by running:

```bash
find . -name "package.json" -not -path "*/node_modules/*" -not -path "*/.changeset/*"
```

For each file, collect all entries from `dependencies`, `devDependencies`, and `peerDependencies`. Record:
- package name
- declared version range (e.g. `^1.2.3`, `~2.0.0`, `1.2.3`)
- which workspace it appears in

Ignore local workspace references (`workspace:*`).

---

## Step 2 — Detect version drift

Group entries by package name across all workspaces. For each package used in more than one workspace, compare the declared version ranges.

Flag any package where the declared ranges differ between workspaces. Report:

| Package | Workspace | Declared version |
|---------|-----------|-----------------|
| `effect` | `packages/core` | `^3.0.0` |
| `effect` | `packages/api` | `^3.1.0` |

**Goal:** every shared package should declare the same version range everywhere. Drift indicates a workspace silently using an older or newer API surface.

---

## Step 3 — Check latest versions on npm

For each unique package found across the repo, fetch its registry metadata from `https://registry.npmjs.org/<package-name>` to get:
- `dist-tags.latest` — the current stable version
- `time` map — release timestamps for every published version

Derive the **currently resolved version** from each workspace's declared range. The "resolved version" is the highest version satisfying the range (e.g. for `^3.1.0`, the highest `3.x.y` on npm).

Use `WebFetch` to retrieve the registry JSON. Be efficient: only fetch a package once even if it appears in multiple workspaces. npm's registry JSON for a package can be large — if a package has many versions, focus on the `dist-tags` and `time` fields.

---

## Step 4 — Evaluate available upgrades

For each package, compare the **resolved version** against `dist-tags.latest`. If they differ, classify the gap:

| Upgrade type | Rule |
|---|---|
| **Patch** (same major.minor) | Available immediately — no waiting period |
| **Minor** (same major, higher minor) | Must have been published ≥ 14 days ago |
| **Major** (higher major) | Must have been published ≥ 30 days ago |

For each candidate upgrade, check `time[<version>]` from the registry to get its publish date. Compare against today's date (from CLAUDE.md context).

Mark upgrades as:
- **Ready** — passes the waiting-period rule; should be applied
- **Pending** — exists but waiting period not yet met; note when it becomes eligible
- **N/A** — already on latest

---

## Step 5 — Read changelogs for ready upgrades

For each **Ready** upgrade, fetch the changelog or release notes to identify any required migration steps or breaking changes — even within minor/patch bumps (many packages document behaviour changes in release notes).

Try these sources in order (stop when you find content):
1. The package's `repository` URL from the registry metadata — look for `CHANGELOG.md` or `RELEASES.md` in the root
2. The GitHub releases page if the repo is on GitHub (`/releases/tag/v<version>`)
3. The npm package page description as a fallback

Read the changelog entries **from the current resolved version up to the target version** (not the full history). Extract:
- Anything labelled `Breaking`, `Migration`, `Deprecated`, or `Required`
- Behaviour changes that affect APIs used in this codebase
- New peer dependency requirements

If no changelog is findable, note that and flag the upgrade for manual review.

---

## Step 6 — Report

### 6a — Version drift

List all packages with version drift across workspaces (from Step 2). For each, recommend the version range all workspaces should align to (prefer the highest compatible range already in use). If no drift, state: "No version drift detected."

### 6b — Upgrades available

For each package with a **Ready** upgrade, report:

**`<package-name>`** `<current>` → `<latest>`  
Upgrade type: Patch / Minor / Major  
Published: `<date>` (N days ago)  
Workspaces: `<list>`  
Changelog notes: `<summary of breaking/migration items, or "None found">`  
Action required: `<specific file/code changes needed, or "Bump version only">`

For **Pending** upgrades, list them in a separate table:

| Package | Current | Available | Type | Eligible from |
|---------|---------|-----------|------|--------------|

### 6c — Recommended `package.json` changes

List every concrete change to make — workspace, package, old range, new range:

| Workspace | Package | Old | New |
|-----------|---------|-----|-----|

These changes address both drift (aligning ranges) and upgrades (bumping to latest ready versions). Apply the highest ready version consistently across all workspaces that use the package.

---

## Step 7 — Apply changes (with confirmation)

Present the table from 6c to the user and ask: "Apply these changes?"

If yes:
1. Edit each affected `package.json` to update the version ranges.
2. Run `bun install` from the repo root to update `bun.lockb`.
3. Run `bun run check` to verify no type errors were introduced.
4. If any migration steps were identified in Step 5, surface them now and ask the user to handle them before continuing.

If no, stop and leave files unchanged.
