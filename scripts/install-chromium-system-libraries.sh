#!/usr/bin/env bash
# Installs what Chromium needs from the system on an Ubuntu runner, as
# `playwright install-deps chromium` does, taking the packages from
# <cache dir> where it holds them and apt's signed index names them. Run it
# from the directory whose `playwright` decides the browser revision
# (cire/host, tools/e2e in ci.yml).
#
# usage: install-chromium-system-libraries.sh <cache dir>
#
# The runner image already has Chromium's libraries; what install-deps still
# downloads is a handful of font packages (21.9 MB on ubuntu-latest 26.04)
# from the image's apt mirror. When that mirror slowed to about 40 KB/s, the
# download ran past the step's ten minutes. So:
#
# - The install runs under scripts/retry.sh: three attempts of 150 s each,
#   about four times the slowest normal run (40 s). The whole attempt runs as
#   root, so retry.sh can stop every process in it, apt-get included. Each
#   attempt finishes what dpkg left half done, fetches apt's index, and then
#   scripts/verify-cached-debs.sh moves into apt's archive each cached package
#   whose SHA-256 that signed index names, and drops the rest. apt downloads
#   whatever the archive lacks, and resumes the downloads an attempt left.
#   Playwright's install-deps fetches the index again; that second fetch finds
#   it unchanged and takes seconds.
# - apt keeps what it downloads, retries a failed fetch, and gives up on a
#   connection that sends nothing for 30 s (its default is 120 s), moving on to
#   the next mirror in the image's list.
# - After the install, the .debs in apt's archive, each checked against the
#   index by verify-cached-debs.sh or by apt as it downloaded it, replace
#   those in <cache dir>, for the workflow to save.
#
# When every attempt fails, the step carries on without apt only if all of
# these hold, and otherwise fails with the last attempt's status:
#
# - no `apt-get update` exited 0. A marker written between it and
#   verify-cached-debs.sh records one that did, so the step never carries on
#   after a cached package was checked or an install began. apt-get update
#   exits 0 on a network failure when it finishes in time (it warns and keeps
#   the old index), so that case fails the step too;
# - apt's output (the lines not starting `::`, since retry.sh's annotations
#   quote the command line) names a network fault: a name it could not
#   resolve, a host it could not connect to, a connection that timed out;
# - it names no signature or hash failure. Anything else is not a network
#   failure;
# - `playwright install-deps --dry-run chromium`, which simulates the install
#   with `apt-get install -s` and changes nothing, exits 0 and prints
#   "All system dependencies are installed.". On a platform it does not know
#   it exits 0 without that line, having checked nothing.
#
# Then it prints one warning starting
# "::warning::install-chromium-system-libraries: skipped apt:", installs
# nothing, leaves <cache dir> as it found it, and exits 0. When it fails
# instead, a line starting "install-chromium-system-libraries: not skipped:"
# says which of these did not hold. apt's messages are matched in English, as
# the runner prints them; in any other language the step fails.
#
# CHROMIUM_APT_ROOT, unset in CI, puts apt's configuration and archive under
# another root, for scripts/tests/install-chromium-system-libraries.cli.test.ts.
set -euo pipefail

cache=${1:?usage: install-chromium-system-libraries.sh <cache dir>}
scripts=$(cd "$(dirname "$0")" && pwd)
root=${CHROMIUM_APT_ROOT:-}
archives=$root/var/cache/apt/archives

# apt's words for a fault on the way to the mirror (methods/connect.cc,
# methods/http.cc and methods/basehttp.cc in apt's source) ...
network="Temporary failure resolving '|Could not resolve '|Could not connect to |Unable to connect to |Connection timed out|Connection failed"
# ... and for an index or package it could not trust (methods/gpgv.cc,
# apt-pkg/acquire-item.cc). Wide on purpose: a false match only fails the step.
untrusted="NO_PUBKEY|BADSIG|EXPKEYSIG|REVKEYSIG|[Ss]ignature|[Ss]igned|[Hh]ash|not valid yet"

state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT

# Fails the step with status $1, saying why, unless no apt-get update
# finished, apt failed on the network alone, and nothing Chromium needs is
# missing; then it warns once and passes, having installed nothing.
without_apt() {
  local status=$1 checked=0
  if [ -e "$state/updated" ]; then
    echo "install-chromium-system-libraries: not skipped: apt-get update finished, so apt held an index"
    exit "$status"
  fi
  awk '!/^::/' "$state/output" >"$state/apt"
  if grep -Eq "$untrusted" "$state/apt"; then
    echo "install-chromium-system-libraries: not skipped: apt reported a signature or hash failure"
    exit "$status"
  fi
  if ! grep -Eq "$network" "$state/apt"; then
    echo "install-chromium-system-libraries: not skipped: apt reported no network failure"
    exit "$status"
  fi
  timeout 60 bunx --no-install playwright install-deps --dry-run chromium \
    >"$state/dry-run" 2>&1 || checked=$?
  cat "$state/dry-run"
  if [ "$checked" -ne 0 ] || ! grep -qxF "All system dependencies are installed." "$state/dry-run"; then
    echo "install-chromium-system-libraries: not skipped: playwright install-deps --dry-run chromium does not report every dependency installed"
    exit "$status"
  fi
  echo "::warning::install-chromium-system-libraries: skipped apt: apt could not reach the mirror and playwright install-deps --dry-run chromium reports nothing missing, so nothing was installed and the package cache was not refreshed"
  exit 0
}

mkdir -p "$cache"
printf '%s\n' \
  'APT::Keep-Downloaded-Packages "true";' \
  'Acquire::Retries "5";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' |
  sudo tee "$root/etc/apt/apt.conf.d/80-ci-chromium" >/dev/null

shopt -s nullglob
cached=("$cache"/*.deb)
echo "install-chromium-system-libraries: ${#cached[@]} packages in the cache"

# Run as root, Playwright calls apt-get itself rather than through sudo. The
# output reaches the log as it comes, and a file without_apt reads.
status=0
# shellcheck disable=SC2016 # $1-$4 are the inner shell's own arguments.
sudo env "PATH=$PATH" bash "$scripts/retry.sh" 3 150 \
  sh -c 'dpkg --configure -a &&
    apt-get update &&
    : >"$4" &&
    bash "$1" "$2" "$3" &&
    bunx --no-install playwright install-deps chromium' \
  sh "$scripts/verify-cached-debs.sh" "$cache" "$archives" "$state/updated" \
  2>&1 | tee "$state/output" || status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then without_apt "$status"; fi

kept=("$archives"/*.deb)
if [ "${#cached[@]}" -gt 0 ]; then rm -rf -- "${cached[@]}"; fi
if [ "${#kept[@]}" -gt 0 ]; then cp "${kept[@]}" "$cache/"; fi
echo "install-chromium-system-libraries: ${#kept[@]} packages kept for the cache"
