---
name: setup-osn
description: Use when setting up or repairing a development environment for this repository on a machine — Bun at the pinned version, the GitHub CLI and its auth, SSH commit signing and the recommended git config, workspace dependencies, lefthook hooks and the portless dev proxy — and verifying it with the type-check, lint and format gates. Also the place to start when bun, gh, turbo or a hook is missing or the wrong version.
---

Set up the development environment for this repository: check each requirement in order, install or configure what is missing, verify with the three gates, and report every requirement's state.

## What this run must produce

A working tree in which `bun run check`, `bun run lint` and `bun run fmt:check` all pass, and a final table — requirement, state found, action taken — so the user sees what changed on their machine. A requirement that could not be met stays in the table with the reason, never silently dropped.

## Read the tree first — versions live there, not here

Every pinned value comes from the repository, so this skill does not go stale when a version bumps:

```bash
cat .bun-version                                  # the Bun the repo runs on
jq -r .packageManager package.json                # must agree with .bun-version
cat lefthook.yml                                  # what the hooks actually run
sed -n 1,20p scripts/setup.sh                     # the non-interactive tail this skill hands off to
```

`CLAUDE.md` §Local URLs holds the portless setup and the named hosts; §Tooling holds the hook conventions. If any of those disagree with what is below, the tree wins.

## When a step cannot run

- **Not macOS** — skip Homebrew and Xcode; install Bun with `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"` and `gh` with the distribution's package manager. iOS work is macOS-only; say so in the table.
- **No sudo** — the portless proxy cannot bind 443 or trust its CA; record it as not installed and give the command for later.
- **No network** — nothing installs. Verify what is present, run the gates if `node_modules` exists, and report the rest as blocked.
- **Non-interactive** — every step that changes global state (git config, SSH keys, the CA trust store, `/etc/hosts`) needs a yes. With no user, report what would change and do not change it. Installing into the repo (`bun install`, `lefthook install`) is fine.

Never claim a gate passed that did not run here.

## Step 1 — Homebrew (macOS)

`which brew`; if absent, install with the script at `https://brew.sh` and add its shellenv line to the shell profile.

## Step 2 — Bun at the pinned version

```bash
bun --version
```

If absent: `brew install bun`. If it does not print the version in `.bun-version`, install that exact version: `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`. Verify again; Turborepo, oxlint, oxfmt, lefthook and changesets all run through `bunx --bun`, so this one gate decides all of them.

## Step 3 — Xcode Command Line Tools (macOS; Swift work only)

`xcode-select -p`; if it errors, `xcode-select --install`. The Swift package at `shared/swift/OSNShared` and the iOS targets need full Xcode from the App Store, not the CLI tools alone — `xcodebuild -version` confirms it. Skip when the user does no native work, and say so.

## Step 4 — GitHub CLI

`gh --version`; if absent, `brew install gh`. Then three checks, because an installed `gh` is not a working one:

1. `gh auth status` — if not logged in, `gh auth login` (GitHub.com, HTTPS, browser)
2. `gh repo view xchromo/osn` — a failure means the token lacks `repo`; `gh auth refresh -s repo`
3. `gh pr list` from the repo root — an empty list is a pass; an error is not

`gh` is what `prep-pr` opens pull requests with and `new-feat` files issues with. Moving a Project item needs the `project` scope as well: `gh auth refresh -s project`, when the user wants that.

## Step 5 — SSH commit signing

Simpler than GPG. Check for a key with `ls ~/.ssh/*.pub`; generate one if none: `ssh-keygen -t ed25519 -C "<email>"`. Then, with the user's yes at each step:

1. Add the public key to GitHub as a **Signing Key** (Settings → SSH and GPG keys → New SSH key, key type *Signing Key*) — separate from the auth key
2. `git config --global gpg.format ssh` and `git config --global user.signingkey ~/.ssh/id_ed25519.pub`
3. An allowed-signers file so local `git log --show-signature` verifies:
   ```bash
   printf '%s namespaces="git" %s\n' "$(git config --global user.email)" "$(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
   git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
   ```

## Step 6 — Git configuration

For each row: run the check; if unset, show the user what it does and ask before applying.

| Setting | Check | Apply | Why |
|---|---|---|---|
| `rerere.enabled` | `git config --global rerere.enabled` | `… true` | Replays a conflict resolution the next time the same conflict appears — long-lived branches rebase often here |
| `push.autoSetupRemote` | `git config --global push.autoSetupRemote` | `… true` | `git push` works on a new branch without `-u origin HEAD` |
| `pull.rebase` | `git config --global pull.rebase` | `… false` | Merge on `git pull`; no surprise rebases |
| `commit.gpgsign` | `git config --global commit.gpgsign` | `… true` | Signs every commit with the key from Step 5 — verified commits on GitHub |

Confirm with `git config --global --list | grep -E 'rerere|push.auto|pull.rebase|gpgsign'`.

## Step 7 — Dependencies, hooks and the gates

`scripts/setup.sh` is the non-interactive tail of this procedure and the thing to run once Bun is right:

```bash
bash scripts/setup.sh
```

It runs `bun install`, `bunx --bun lefthook install`, and then `bun run check`, `bun run lint` and `bun run fmt:check`. Read `lefthook.yml` for what the hooks do — as of this writing pre-commit runs oxlint and oxfmt in write mode with `stage_fixed`, and pre-push runs the type check, `bun audit --audit-level=high` and the release-age check — and tell the user, because a pre-push that refuses on an advisory reads like a broken hook to someone who was not told.

`bunfig.toml` sets a three-day `minimumReleaseAge`, so a package published yesterday will not install; that is the gate working, not a network fault.

If a gate fails, paste the shortest decisive lines into the table and keep going — a failing type check on a clean checkout of `main` is a finding for the user, not a reason to stop the setup.

## Step 8 — The dev proxy (optional, needs sudo)

Every dev server answers on a named HTTPS host through portless (`https://musubi.localhost`, `https://host.cire.localhost`, …). One-time setup binds port 443, adds a local CA to the trust store and writes an `/etc/hosts` block, so it asks for sudo and for the user's yes:

```bash
bunx portless proxy start     # or: bunx portless service install, to start at boot
bunx portless doctor          # proxy, routes, DNS, CA trust
```

That CA can intercept TLS for every host the machine talks to, which is why `portless` is tilde-pinned in `package.json` — a version bump is a change to review. `bunx portless clean` undoes all of it. To skip the proxy entirely: `PORTLESS=0 bun run dev` runs on the fixed ports.

## Step 9 — Report

The table, then one line: ready, or what is still blocked. Homebrew dependencies for reference: `bun` (everything), `gh` (`prep-pr`, `new-feat`), Xcode CLT (Swift and iOS only).
