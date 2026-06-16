#!/usr/bin/env bash
# Non-interactive OSN setup: install workspace deps, register git hooks, then
# verify the tree type-checks, lints, and is formatted. Mirrors the automated
# tail of the /setup-osn flow (steps 7-9). The interactive toolchain install
# (bun, rust, gh, ssh) and git-config steps stay in
# .claude/commands/setup-osn.md.
#
# Prerequisite: bun is already installed (see /setup-osn for bootstrap).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dependencies (bun install)"
bun install

echo "==> Registering git hooks (lefthook install)"
bunx --bun lefthook install

echo "==> Verifying: type-check, lint, format"
bun run check
bun run lint
bun run fmt:check

echo "✅ Setup complete — environment ready."
