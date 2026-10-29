#!/usr/bin/env bash
# Tests for scripts/secret-scan.sh. Each case builds throwaway repositories in a
# temp directory, with identity and global config isolated the way
# release-commit.test.sh does it. Synthetic keys are built at runtime, so no
# secret-shaped literal enters the repository.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCAN="$HERE/../secret-scan.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

PASS=0
FAIL=0

expect() { # name, want, actual
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL $1: want $2, got $3"
  fi
}

token() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c36; }

# A repository with one base commit and one commit adding a leaking file.
# Sets REPO and TOK. origin/main points at the base commit.
leaky_repo() {
  REPO="$WORK/r$RANDOM$RANDOM"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" commit -q --allow-empty -m base
  git -C "$REPO" update-ref refs/remotes/origin/main HEAD
  echo ok > "$REPO/a.txt"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m clean
  TOK=$(token)
  printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/b.txt"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m leak
}

run_in() { ( cd "$REPO" && bash "$SCAN" "$@" ); }

# 1–3, 4–5: range input and leaks.
leaky_repo
run_in range >/dev/null 2>&1; expect "1 range without a base exits 1" 1 $?
run_in range nosuchref HEAD >/dev/null 2>&1; expect "2 base not in the clone exits 1" 1 $?
run_in range 0000000000000000000000000000000000000000 HEAD >/dev/null 2>&1; expect "3 all-zero base exits 1" 1 $?
run_in range origin/main HEAD >"$WORK/out4" 2>&1; expect "4 range adding a synthetic key exits 2" 2 $?
expect "4b output names no key value" 0 "$(grep -c -- "$TOK" "$WORK/out4")"
run_in range origin/main HEAD~1 >/dev/null 2>&1; expect "5 clean range exits 0" 0 $?

# 6: gitleaks absent.
PATH=/usr/bin:/bin /bin/bash "$SCAN" range origin/main HEAD >"$WORK/out6" 2>&1
expect "6 gitleaks absent exits 1" 1 $?
expect "6b the reason is the missing tool" 1 "$(grep -c "not installed" "$WORK/out6")"

# 7: a checkout .gitleaksignore that would suppress the leak must not apply.
leaky_repo
FP=$(cd "$REPO" && gitleaks git . --log-opts "origin/main..HEAD" --no-banner --redact -r "$WORK/fp.json" --report-format json --log-level error >/dev/null 2>&1; jq -r '.[0].Fingerprint' "$WORK/fp.json" 2>/dev/null)
printf '%s\n' "$FP" > "$REPO/.gitleaksignore"
run_in range origin/main HEAD >/dev/null 2>&1; expect "7 checkout .gitleaksignore does not suppress" 2 $?
expect "7a the fingerprint lookup found a value" 1 "$([ -n "$FP" ] && [ "$FP" != null ] && echo 1 || echo 0)"
rm -f "$REPO/.gitleaksignore"

# 8: a checkout .gitleaks.toml that allow-lists everything must not apply.
leaky_repo
printf '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n' > "$REPO/.gitleaks.toml"
run_in range origin/main HEAD >/dev/null 2>&1; expect "8 checkout .gitleaks.toml does not switch the scan off" 2 $?

# 9: origin/main's config allow-lists b.txt, so the leak is accepted.
leaky_repo
CFG_TMP="$WORK/cfg"; mkdir -p "$CFG_TMP"
cat > "$CFG_TMP/.gitleaks.toml" <<'TOML'
[extend]
useDefault = true
[[allowlists]]
paths = ['^b\.txt$']
TOML
git -C "$REPO" worktree add -q --detach "$WORK/wt" origin/main 2>/dev/null
cp "$CFG_TMP/.gitleaks.toml" "$WORK/wt/" && git -C "$WORK/wt" add .gitleaks.toml && git -C "$WORK/wt" commit -q -m cfg
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$WORK/wt" rev-parse HEAD)"
run_in range origin/main HEAD >/dev/null 2>&1; expect "9 origin/main config allow-lists the path" 0 $?
git -C "$REPO" worktree remove --force "$WORK/wt" 2>/dev/null || true

# 10: origin/main's config malformed.
leaky_repo
printf '[extend\n' > "$CFG_TMP/bad.toml"
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
BAD=$(git -C "$REPO" hash-object -w "$CFG_TMP/bad.toml")
TREE=$(git -C "$REPO" mktree <<EOF
100644 blob $BAD	.gitleaks.toml
EOF
)
C=$(git -C "$REPO" commit-tree "$TREE" -p HEAD -m cfg)
git -C "$REPO" update-ref refs/remotes/origin/main "$C"
run_in range origin/main HEAD >/dev/null 2>&1; expect "10 malformed origin/main config exits 1" 1 $?

# 11: origin/main ref missing.
leaky_repo
git -C "$REPO" update-ref -d refs/remotes/origin/main
run_in range HEAD~1 HEAD >/dev/null 2>&1; expect "11 missing origin/main exits 1" 1 $?

# 12: GITLEAKS_CONFIG pointing at a permissive file changes nothing.
leaky_repo
printf '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n' > "$WORK/permissive.toml"
( cd "$REPO" && GITLEAKS_CONFIG="$WORK/permissive.toml" bash "$SCAN" range origin/main HEAD >/dev/null 2>&1 )
expect "12 GITLEAKS_CONFIG is ignored" 2 $?

# 13: the staged mode, and a real commit through the hook.
leaky_repo
git -C "$REPO" reset -q --hard HEAD~1
printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/c.txt"
git -C "$REPO" add c.txt
( cd "$REPO" && bash "$SCAN" staged >/dev/null 2>&1 ); expect "13 staged leak exits 2" 2 $?

# 14: staged mode with gitleaks absent warns and exits 0.
( cd "$REPO" && PATH=/usr/bin:/bin /bin/bash "$SCAN" staged >"$WORK/out14" 2>&1 ); rc=$?
expect "14 staged, gitleaks absent exits 0" 0 "$rc"
expect "14b the skip line says CI will scan" 1 "$(grep -c 'CI will scan' "$WORK/out14")"

# 15: the report file holds no key value.
leaky_repo
( cd "$REPO" && SECRET_SCAN_REPORT="$WORK/report.json" bash "$SCAN" range origin/main HEAD >/dev/null 2>&1 )
expect "15 report file exists" 1 "$([ -f "$WORK/report.json" ] && echo 1 || echo 0)"
expect "15b report file holds no key value" 0 "$(grep -c -- "$TOK" "$WORK/report.json")"

# 16: check-config refuses an invalid regex (a Go panic exits 2 there) and
# accepts a valid one.
printf '[extend]\nuseDefault = true\n[[allowlists]]\nregexes = ["("]\n' > "$WORK/bad-regex.toml"
bash "$SCAN" check-config "$WORK/bad-regex.toml" >/dev/null 2>&1; expect "16 invalid regex config exits 1" 1 $?
printf '[extend]\nuseDefault = true\n' > "$WORK/good.toml"
bash "$SCAN" check-config "$WORK/good.toml" >/dev/null 2>&1; expect "16b valid config exits 0" 0 $?

# 17: a real pre-commit hook. `git commit -a` must be refused, which needs
# GIT_INDEX_FILE to survive into the hook.
leaky_repo
git -C "$REPO" reset -q --hard HEAD~1
HOOKS="$WORK/hooks"; mkdir -p "$HOOKS"
printf '#!/usr/bin/env bash\nexec bash "%s" staged\n' "$SCAN" > "$HOOKS/pre-commit"; chmod +x "$HOOKS/pre-commit"
printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/tracked.txt"
git -C "$REPO" add tracked.txt && git -C "$REPO" commit -q -m tracked
printf 'k = "ghp_%s"\n' "$(token)" > "$REPO/tracked.txt"
( cd "$REPO" && git -c core.hooksPath="$HOOKS" commit -q -a -m leaked >/dev/null 2>&1 ); rc=$?
expect "17 git commit -a through the hook is refused" 1 "$([ "$rc" != 0 ] && echo 1 || echo 0)"

# 18: a tag named origin/main cannot stand in for the policy ref.
leaky_repo
PERM_TREE=$(printf '100644 blob %s\t.gitleaks.toml\n' "$(printf '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n' | git -C "$REPO" hash-object -w --stdin)" | git -C "$REPO" mktree)
PERM=$(git -C "$REPO" commit-tree "$PERM_TREE" -p "$(git -C "$REPO" rev-parse HEAD~2)" -m perm)
git -C "$REPO" tag origin/main "$PERM"
( cd "$REPO" && bash "$SCAN" range refs/remotes/origin/main HEAD >/dev/null 2>&1 ); expect "18 a tag named origin/main does not switch the scan off" 2 $?
git -C "$REPO" tag -d origin/main >/dev/null

# 19: gitleaks that exits 0 after a git failure is an error, not a clean scan.
leaky_repo
SHIM="$WORK/shim-fatal"; mkdir -p "$SHIM"
printf '#!/bin/sh\nif [ "$1" = version ]; then echo 8.30.1; exit 0; fi\necho "fatal: simulated git failure" >&2\nexit 0\n' > "$SHIM/gitleaks"; chmod +x "$SHIM/gitleaks"
( cd "$REPO" && PATH="$SHIM:/usr/bin:/bin" bash "$SCAN" range origin/main HEAD >/dev/null 2>&1 ); expect "19 gitleaks exiting 0 after a git failure exits 1" 1 $?

# 20: a secret added during a merge is scanned (first-parent diff of the merge).
REPO="$WORK/merge$RANDOM"; mkdir -p "$REPO"; git -C "$REPO" init -q
git -C "$REPO" commit -q --allow-empty -m base
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" checkout -q -b side; echo side > "$REPO/s.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -q -m side
git -C "$REPO" checkout -q -; git -C "$REPO" merge --no-commit --no-ff -q side >/dev/null 2>&1 || true
TOK=$(token); printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/merged.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -q -m merge
( cd "$REPO" && bash "$SCAN" range origin/main HEAD >"$WORK/out20" 2>&1 ); expect "20 a secret added during a merge exits 2" 2 $?
expect "20b output names no key value" 0 "$(grep -c -- "$TOK" "$WORK/out20")"

# 21: a gitleaks:allow comment does not hide a secret from the CI scan.
leaky_repo
printf 'k = "ghp_%s" # gitleaks:allow\n' "$TOK" > "$REPO/b.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -q --amend -m leak
run_in range origin/main HEAD >/dev/null 2>&1; expect "21 gitleaks:allow comment does not hide a secret" 2 $?

# 22: a panicking config on origin/main is an error, never a reported leak.
leaky_repo
BADCFG=$(printf '[extend]\nuseDefault = true\n[[allowlists]]\nregexes = ["("]\n' | git -C "$REPO" hash-object -w --stdin)
TREE=$(printf '100644 blob %s\t.gitleaks.toml\n' "$BADCFG" | git -C "$REPO" mktree)
C=$(git -C "$REPO" commit-tree "$TREE" -m badcfg); git -C "$REPO" update-ref refs/remotes/origin/main "$C"
run_in range origin/main HEAD >"$WORK/out22" 2>&1; expect "22 invalid regex in origin/main config exits 1" 1 $?
expect "22b no leaks line for a broken policy" 0 "$(grep -c 'leaks found' "$WORK/out22")"

# 23: an old gitleaks is refused in range mode and skipped with a reason in staged mode.
leaky_repo
SHIM="$WORK/shim-old"; mkdir -p "$SHIM"
printf '#!/bin/sh\nif [ "$1" = version ]; then echo 8.0.0; exit 0; fi\nexec /opt/homebrew/bin/gitleaks "$@"\n' > "$SHIM/gitleaks"; chmod +x "$SHIM/gitleaks"
( cd "$REPO" && PATH="$SHIM:/usr/bin:/bin" bash "$SCAN" range origin/main HEAD >"$WORK/out23" 2>&1 ); expect "23 gitleaks older than 8.30.1 exits 1" 1 $?
expect "23b the reason says older" 1 "$(grep -c 'older than' "$WORK/out23")"
( cd "$REPO" && PATH="$SHIM:/usr/bin:/bin" bash "$SCAN" staged >"$WORK/out23s" 2>&1 ); expect "23c staged skips with a reason" 0 $?
expect "23d the skip line says CI will scan" 1 "$(grep -c 'CI will scan' "$WORK/out23s")"

# 24: a permissive policy committed inside the scanned range does not apply.
leaky_repo
PERM_BLOB=$(printf '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n' | git -C "$REPO" hash-object -w --stdin)
PT=$(printf '100644 blob %s\t.gitleaks.toml\n' "$PERM_BLOB" | git -C "$REPO" mktree)
PC=$(git -C "$REPO" commit-tree "$PT" -p HEAD -m perm); git -C "$REPO" update-ref HEAD "$PC"
run_in range origin/main HEAD >/dev/null 2>&1; expect "24 a permissive config committed in the range does not apply" 2 $?

# 25: the staged hook runs against a permissive checkout config without taking it.
leaky_repo
git -C "$REPO" reset -q --hard HEAD~1
printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/c.txt"; git -C "$REPO" add c.txt
printf '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n' > "$REPO/.gitleaks.toml"
( cd "$REPO" && bash "$SCAN" staged >/dev/null 2>&1 ); expect "25 staged mode ignores a permissive checkout config" 2 $?

# 26: each fixture file allows only its own rule; a different secret in it still fails.
REPO="$WORK/fx$RANDOM"; mkdir -p "$REPO/cire/infra/tests"; git -C "$REPO" init -q
cp "$HERE/../../.gitleaks.toml" "$REPO/.gitleaks.toml"
git -C "$REPO" add -A; git -C "$REPO" commit -q -m policy; git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" commit -q --allow-empty -m base2
SK=sk_live_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c24)
printf 'k = "%s"\n' "$SK" > "$REPO/cire/infra/tests/evaluate.ts"; git -C "$REPO" add -A; git -C "$REPO" commit -q -m fixture
( cd "$REPO" && bash "$SCAN" range refs/remotes/origin/main HEAD >/dev/null 2>&1 ); expect "26 the fixture's own rule is allowed in its file" 0 $?
printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/cire/infra/tests/evaluate.ts"; git -C "$REPO" add -A; git -C "$REPO" commit -q -m other
( cd "$REPO" && bash "$SCAN" range refs/remotes/origin/main HEAD >/dev/null 2>&1 ); expect "26b another rule in the same file still fails" 2 $?

# 27: the hook command is the one the lefthook config installs, with no glob.
expect "27 lefthook runs the staged scan with no glob" 0 "$(awk '/^    secrets:/{f=1} f&&/glob:/{print "x"} /^pre-push:/{f=0}' "$HERE/../../lefthook.yml" | grep -c x)"
expect "27b the command is present" 1 "$(grep -c 'bash scripts/secret-scan.sh staged' "$HERE/../../lefthook.yml")"

# 28: the staged refusal names the leak, so a hook that merely failed cannot pass.
leaky_repo
git -C "$REPO" reset -q --hard HEAD~1
printf 'k = "ghp_%s"\n' "$TOK" > "$REPO/c.txt"; git -C "$REPO" add c.txt
( cd "$REPO" && bash "$SCAN" staged >"$WORK/out28" 2>&1 ); rc=$?
expect "28 staged leak exits 2" 2 "$rc"
expect "28b the output says leaks found" 1 "$(grep -q 'leaks found' "$WORK/out28" && echo 1 || echo 0)"

echo "secret-scan tests: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
