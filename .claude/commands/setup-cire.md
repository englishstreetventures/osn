Set up the Cire development environment. Check each requirement in order and install or configure anything missing.

---

## Project Stack

| Layer | Technology |
|---|---|
| Runtime | Bun 1.x |
| Edge runtime | Cloudflare Workers (via wrangler) |
| Frontend | Astro + SolidJS + View Transitions |
| Animations | Motion One (`@motionone/solid`) |
| Backend | Hono on Cloudflare Workers |
| Database | Cloudflare D1 + Drizzle ORM |
| Testing | Vitest |
| Linting | oxlint |
| Formatting | oxfmt |
| Git hooks | lefthook |
| CI/CD | GitHub Actions → Cloudflare Pages + Workers |

---

## Step 1 — Bun

Run `bun --version`.

- If not installed: `curl -fsSL https://bun.sh/install | bash`
- If below 1.0: `bun upgrade`

Verify: `bun --version` prints `1.x.x` or higher.

---

## Step 2 — Wrangler (Cloudflare CLI)

Run `bunx wrangler --version`.

- If not installed: `bun add -g wrangler`

Then check Cloudflare authentication:
1. `bunx wrangler whoami` — if not logged in: `bunx wrangler login`
2. Confirm D1 access: `bunx wrangler d1 list` — the `cire-db` database should appear once created

---

## Step 3 — GitHub CLI

Run `gh --version`. If not installed: `brew install gh` (macOS).

Verify:
1. `gh auth status` — if not logged in: `gh auth login`
2. `gh repo view` — confirm repo access

---

## Step 4 — SSH signing key

1. Check for existing key: `ls ~/.ssh/*.pub`
2. Generate if missing: `ssh-keygen -t ed25519 -C "your@email.com"`
3. Add to GitHub as a **Signing Key** (Settings → SSH keys → New SSH key → type: Signing Key)
4. Configure git:
   ```bash
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   ```
5. Register allowed signers:
   ```bash
   printf '%s namespaces="git" %s\n' "$(git config --global user.email)" "$(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
   git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
   ```

---

## Step 5 — Git configuration

Check and apply the following settings:

| Setting | Command | Why |
|---|---|---|
| `rerere.enabled true` | `git config --global rerere.enabled true` | Replay conflict resolutions on rebase |
| `push.autoSetupRemote true` | `git config --global push.autoSetupRemote true` | `git push` works on new branches without `-u` |
| `pull.rebase false` | `git config --global pull.rebase false` | Use merge on pull for predictable history |
| `commit.gpgsign true` | `git config --global commit.gpgsign true` | Sign all commits with SSH key |

For each: check with `git config --global <key>`, explain what it does, ask to apply if not already set.

---

## Step 6 — Install dependencies

```bash
bun install
```

Then register lefthook hooks:

```bash
bunx lefthook install
```

Verify hooks are registered: `cat .git/hooks/pre-push` should reference lefthook.

---

## Step 7 — Database setup (once `packages/db` is scaffolded)

Apply local D1 migrations:

```bash
bunx wrangler d1 migrations apply cire-db --local
```

Optionally run the seed script:

```bash
bun --cwd packages/db run seed
```

Verify schema applied:

```bash
bunx wrangler d1 execute cire-db --local --command "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## Step 8 — Verify the setup

Run the following checks in parallel and report results:

1. `bun run build` — confirms all workspaces compile cleanly
2. `bunx oxlint .` — confirms no lint errors
3. `bun run test` — confirms all tests pass

If all pass, the environment is ready.

---

## Summary of dependencies

| Tool | Install | Required for |
|---|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` | Runtime, package manager |
| Wrangler | `bun add -g wrangler` | Cloudflare Workers, D1, Pages deploy |
| GitHub CLI | `brew install gh` | Repo access, pushing branches |
| lefthook | via `bun install` | Pre-push git hooks |
| oxlint | via `bun install` | Linting |
| oxfmt | via `bun install` | Formatting |
