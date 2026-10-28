#!/usr/bin/env bash
# Secret scan for CI and the local pre-commit hook.
#
#   secret-scan.sh range <base> <head>   scan the commits in base..head (CI)
#   secret-scan.sh staged                scan the staged content (hook, advisory)
#   secret-scan.sh check-config <file>   parse-only check of a gitleaks config
#
# Exit: 0 clean, 2 leaks found, 1 any error. gitleaks is run with a leak exit
# code of 3 so that a Go panic (exit 2, e.g. an invalid regex in a config) is
# never reported as a leak.
set -euo pipefail

LEAK_EXIT=3
MIN_VERSION=8.30.1
POLICY_REF=origin/main
POLICY_PATH=.gitleaks.toml

die() { echo "secret-scan: $*" >&2; exit 1; }
warn() { echo "secret-scan: $*" >&2; }

# A neutral working directory: gitleaks loads .gitleaksignore from the working
# directory through the default of -i, so every scan passes -i and runs from here.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
NEUTRAL="$TMP/neutral"
mkdir -p "$NEUTRAL"
: > "$TMP/no-ignore-here"

# Installed gitleaks at or above MIN_VERSION. Prints a reason on failure.
gitleaks_ok() {
  command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks is not installed (brew install gitleaks)"; return 1; }
  local ver
  ver=$(gitleaks version 2>/dev/null | tr -d '[:space:]') || { echo "gitleaks version failed"; return 1; }
  if [ "$(printf '%s\n%s\n' "$MIN_VERSION" "$ver" | sort -V | head -1)" != "$MIN_VERSION" ]; then
    echo "gitleaks $ver is older than $MIN_VERSION (brew upgrade gitleaks)"
    return 1
  fi
}

# Write the policy config to $1: origin/main's .gitleaks.toml, or built-in
# rules only when origin/main has none. Never reads the checkout's copy.
write_config() {
  if ! git rev-parse --verify --quiet "$POLICY_REF^{commit}" >/dev/null; then
    return 1
  fi
  if git cat-file -e "$POLICY_REF:$POLICY_PATH" 2>/dev/null; then
    git show "$POLICY_REF:$POLICY_PATH" > "$1"
  else
    printf '[extend]\nuseDefault = true\n' > "$1"
  fi
}

# Run gitleaks git on repo $1 with config $2 and the rest as arguments. Maps the
# leak exit code to 2 and every other failure to 1.
run_scan() {
  local target=$1 cfg=$2
  shift 2
  local rc=0
  (
    cd "$NEUTRAL"
    env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML \
      gitleaks git "$target" "$@" \
        --config "$cfg" -i "$TMP/no-ignore-here" --ignore-gitleaks-allow \
        --redact -v --no-banner --exit-code "$LEAK_EXIT" \
        -r "${SECRET_SCAN_REPORT:-$TMP/secret-scan.json}" --report-format json
  ) || rc=$?
  case "$rc" in
    0) return 0 ;;
    "$LEAK_EXIT") echo "secret-scan: leaks found; the file, line and rule are above, the value is masked" >&2; return 2 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  range)
    base=${2:-}; head=${3:-}
    [ -n "$base" ] || die "range needs a base"
    [ -n "$head" ] || die "range needs a head"
    case "$base" in
      0000000000000000000000000000000000000000) die "base is all zeros" ;;
    esac
    if ! reason=$(gitleaks_ok); then die "$reason"; fi
    # Resolve to SHAs in the checkout: a bare clone copies no remote-tracking refs,
    # so a symbolic name such as origin/main would resolve to nothing there.
    base_sha=$(git rev-parse --verify --quiet "$base^{commit}") || die "base '$base' is not a commit in this checkout"
    head_sha=$(git rev-parse --verify --quiet "$head^{commit}") || die "head '$head' is not a commit in this checkout"
    write_config "$TMP/config.toml" || die "$POLICY_REF is not in this checkout; fetch it"
    git clone -q --bare --local . "$TMP/scan.git" || die "could not clone the checkout for scanning"
    run_scan "$TMP/scan.git" "$TMP/config.toml" --log-opts "$base_sha..$head_sha"
    ;;

  staged)
    if ! reason=$(gitleaks_ok); then
      warn "secret scan skipped: $reason; CI will scan this commit"
      exit 0
    fi
    if ! write_config "$TMP/config.toml"; then
      warn "$POLICY_REF is not in this checkout; using gitleaks' built-in rules for this commit"
      printf '[extend]\nuseDefault = true\n' > "$TMP/config.toml"
    fi
    top=$(git rev-parse --show-toplevel)
    run_scan "$top" "$TMP/config.toml" --pre-commit --staged
    ;;

  check-config)
    f=${2:-$POLICY_PATH}
    [ -f "$f" ] || die "no config at $f"
    f="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
    reason=$(gitleaks_ok) || die "$reason"
    mkdir -p "$TMP/empty"
    rc=0
    (cd "$NEUTRAL" && gitleaks dir "$TMP/empty" --config "$f" -i "$TMP/no-ignore-here" \
      --no-banner --exit-code "$LEAK_EXIT" >/dev/null 2>&1) || rc=$?
    [ "$rc" = 0 ] || die "$f does not load (gitleaks exit $rc)"
    echo "secret-scan: $f loads"
    ;;

  *)
    die "usage: secret-scan.sh range <base> <head> | staged | check-config <file>"
    ;;
esac
