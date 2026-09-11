#!/usr/bin/env bash
# Tests for changeset-required.sh. Plain-bash assertions (no bats dependency),
# matching the ethos of validate-changesets.test.sh next door. Each case feeds a
# fixture file list on stdin and asserts the printed verdict.
#
# Run: bash scripts/tests/changeset-required.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
script="$here/changeset-required.sh"
pass=0
fail=0

run_case() {
  local name="$1" want="$2" files="$3"
  local got
  got=$(printf '%s' "$files" | bash "$script")
  if [ "$got" = "$want" ]; then
    echo "ok   - $name ($got)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (got '$got', want '$want')"
    fail=$((fail + 1))
  fi
}

run_case "swift scaffolding only" skip \
  'shared/swift/OSNShared/Package.swift
pulse/ios/project.yml
.github/workflows/ci-swift.yml
.gitignore
scripts/changeset-required.sh'

run_case "wiki and top-level prose only" skip \
  'wiki/TODO.md
CLAUDE.md
README.md'

# cire's own vault. Under `cire/`, but shipped by no cire package.
run_case "cire wiki only" skip \
  'cire/wiki/index.md
cire/wiki/architecture/guest-event-editor.md'

run_case "cire wiki plus a cire source file" required \
  'cire/wiki/index.md
cire/host/src/lib/osn.ts'

run_case "retired cire/CLAUDE.md alone" skip \
  'cire/CLAUDE.md'

run_case "retired cire/CLAUDE.md plus a source file" required \
  'cire/CLAUDE.md
cire/api/src/index.ts'

# Agent instructions: read by the coding agent, shipped by no package.
run_case "agent instructions only" skip \
  '.claude/commands/prep-pr.md
.claude/skills/obsidian/SKILL.md
.claude/settings.json'

run_case "agent instructions plus one source file" required \
  '.claude/commands/prep-pr.md
cire/api/src/index.ts'

# RETIRED PATHS — `.agents/skills/` held third-party skills installed by
# `npx skills add` and `skills-lock.json` pinned them; both went with the
# Effect v4 migration. The allowlist entries survive only so the removal PR's
# own deletions do not trip this gate, so these two cases go WITH those
# entries when they are dropped.
run_case "retired third-party skill tree alone" skip \
  '.agents/skills/effect-v3-to-v4/SKILL.md
.claude/skills/effect-v3-to-v4
skills-lock.json'

run_case "retired third-party skill tree plus one source file" required \
  '.agents/skills/effect-ts/SKILL.md
osn/api/src/index.ts'

run_case "source file in a versioned package" required \
  'osn/api/src/routes/graph.ts'

run_case "package.json bump" required \
  'pulse/web/package.json'

# The case a denylist would miss: a lockfile-only `bun update` changes what
# every deployed package builds from without touching a workspace file.
run_case "lockfile alone" required 'bun.lock'

run_case "root config alone" required 'turbo.json'
run_case "root tsconfig alone" required 'tsconfig.json'

run_case "swift plus one source file" required \
  'shared/swift/OSNShared/Package.swift
osn/api/src/index.ts'

run_case "empty diff" skip ''

# changeset-check.yml pipes `printf '%s\n' "$diff"`, not a bare empty string —
# for an empty diff that is one newline byte, still on a pipe. Confirm the TTY
# guard leaves that alone: stdin is a pipe either way, so `-t 0` stays false.
name="empty diff via CI's own printf form"
got=$(printf '%s\n' "" | bash "$script")
if [ "$got" = "skip" ]; then
  echo "ok   - $name ($got)"
  pass=$((pass + 1))
else
  echo "FAIL - $name (got '$got', want 'skip')"
  fail=$((fail + 1))
fi

# Every case above runs the script on a pipe, so none of them can reach the
# `[ -t 0 ]` branch — a harness's own stdin is never a terminal. Attach the
# script's stdin to a real pseudo-terminal instead, via Python's stdlib `pty`
# module, and check that it refuses. A regression that dropped the guard would
# otherwise block forever on `read` against a pty nothing writes to, so an EOF
# (Ctrl-D) goes to the pty right after the fork — harmless to the guarded
# script, which exits before ever reading, and what turns a removed guard into
# an observed `skip`/exit 0 instead of a hang. `signal.alarm` is a second,
# independent backstop in case anything else blocks.
name="refuses when stdin is a terminal"
if command -v python3 >/dev/null 2>&1; then
  result=$(python3 - "$script" <<'PYEOF' 2>&1
import os, pty, signal, sys

def on_alarm(signum, frame):
    sys.stdout.write("\n__EXIT__:124\n")  # 124: conventional shell timeout code
    os._exit(124)

signal.signal(signal.SIGALRM, on_alarm)
signal.alarm(10)

script = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", script])
    os._exit(127)  # execvp only returns on failure

os.write(fd, b"\x04")  # EOF, in case the guard is gone and the script reads

output = b""
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
_, status = os.waitpid(pid, 0)
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
signal.alarm(0)
sys.stdout.buffer.write(output)
sys.stdout.write("\n__EXIT__:%d\n" % code)
PYEOF
)
  code=$(printf '%s\n' "$result" | sed -n 's/^__EXIT__:\(-\{0,1\}[0-9]*\)$/\1/p')
  msg=$(printf '%s\n' "$result" | grep -v '^__EXIT__:')
  if [ "$code" != "0" ] && printf '%s' "$msg" | grep -q "reads the changed-file list on stdin"; then
    echo "ok   - $name (exit $code)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (exit '$code', output: $msg)"
    fail=$((fail + 1))
  fi
elif [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  # No silent green in CI: a missing interpreter there is an environment
  # regression, not a reason to drop the only test of this guard.
  echo "FAIL - $name (no python3 in CI — cannot allocate a pseudo-terminal to test the TTY guard)"
  fail=$((fail + 1))
else
  echo "skip - $name (no python3 — cannot allocate a pseudo-terminal here)"
fi

# A `*` glob spans `/`, so an allowlisted prefix followed by `..` would
# otherwise escape it. Unreachable via `git diff --name-only`, guarded anyway.
run_case "dot-dot escape from an allowed prefix" required \
  'scripts/../osn/api/src/routes/graph.ts'

run_case "dot-dot escape to a root file" required 'wiki/../bun.lock'
run_case "absolute path" required '/etc/passwd'
run_case "single-dot segment" required 'wiki/./TODO.md'

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
