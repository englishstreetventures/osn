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
# - apt keeps what it downloads. How often it retries a fetch and how long it
#   waits on a silent connection are the image's: its
#   /etc/apt/apt.conf.d/zz-retries sorts after every NN-* file, and apt keeps
#   the last value it reads.
# - When an index fails its signature check and an older copy is on disk,
#   apt warns, keeps that copy and carries on, as after a fetch failure. It
#   also runs each command listed under APT::Update::Auth-Failure, and fails
#   the update when one fails. The script lists `false` there, so both
#   updates, the script's and Playwright's, fail instead: no attempt checks
#   the cache against, or installs from, an index apt has just refused to
#   renew, and the step fails with the signature line below.
# - When the mirror's names do not resolve, `apt-get update` makes about ten
#   lookups in a row before it gives up, and apt's timeouts do not cover them.
#   Each lookup is two DNS queries, SRV and address, and glibc waits 10 s on
#   each (5 s, twice): about 200 s, more than an attempt's 150 s. Here apt
#   skips the SRV query, which no Ubuntu mirror answers, and the attempt runs
#   with RES_OPTIONS="timeout:2 attempts:1", so a lookup waits 2 s and both
#   updates finish in the attempt. apt-get update then warns, exits 0 and
#   keeps the index already on disk, which apt checked when it fetched it;
#   verify-cached-debs.sh checks the cache against that index, and apt
#   installs from its archive what the index names, without the network. The
#   step passes with one warning starting
#   "::warning::install-chromium-system-libraries: apt-get update could not
#   fetch every index". A resolver that answers within 2 s works as before.
#   One slower than that fails each lookup, so with every mirror it leads to
#   the same index on disk: the step passes with that warning when the cache
#   holds what the index names, and otherwise fails.
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
#   the old index), so that case fails the step too: when apt then could not
#   download a package the cache lacked at the version that index names, the
#   line saying why says so;
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
# apt-get update's warning when a fetch failed on the network and it kept the
# index on disk (apt-pkg/update.cc; after a signature failure apt fails the
# update instead, as set below), and apt-get install's error when it could not
# download a package (apt-private/private-install.cc).
kept_index="W: Some index files failed to download. They have been ignored, or old ones used instead."
not_fetched="E: Unable to fetch some archives"

# Each try of a DNS query waits 2 s, once: glibc's default is 5 s, twice
# (resolv/resolv.h), and RES_OPTIONS overrides /etc/resolv.conf
# (resolv/res_init.c). A stub resolver answers in milliseconds.
resolver="timeout:2 attempts:1"

state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT

# Fails the step with status $1, saying why, unless no apt-get update
# finished, apt failed on the network alone, and nothing Chromium needs is
# missing; then it warns once and passes, having installed nothing.
without_apt() {
  local status=$1 checked=0
  awk '!/^::/' "$state/output" >"$state/apt"
  if [ -e "$state/updated" ]; then
    if grep -qxF "$kept_index" "$state/apt" && grep -qF "$not_fetched" "$state/apt"; then
      echo "install-chromium-system-libraries: not skipped: apt-get update could not fetch every index and kept the copies on disk, and apt could not download a package the cache lacked at the version they name"
    else
      echo "install-chromium-system-libraries: not skipped: apt-get update finished, so apt held an index"
    fi
    exit "$status"
  fi
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
# The third line fails an update in which an index failed its signature check
# (apt-pkg/acquire-item.cc runs the list, apt-pkg/contrib/fileutl.cc fails on
# a command that does).
printf '%s\n' \
  'APT::Keep-Downloaded-Packages "true";' \
  'Acquire::EnableSrvRecords "false";' \
  'APT::Update::Auth-Failure { "false"; };' |
  sudo tee "$root/etc/apt/apt.conf.d/80-ci-chromium" >/dev/null

shopt -s nullglob
cached=("$cache"/*.deb)
echo "install-chromium-system-libraries: ${#cached[@]} packages in the cache"

# Run as root, Playwright calls apt-get itself rather than through sudo, with
# this environment. The output reaches the log as it comes, and a file
# without_apt and the warning below read. When tee cannot write that file the
# step fails: read in part, it could lose that warning or a line without_apt
# needs.
pipe=(0 0)
# shellcheck disable=SC2016 # $1-$4 are the inner shell's own arguments.
sudo env "PATH=$PATH" "RES_OPTIONS=$resolver" bash "$scripts/retry.sh" 3 150 \
  sh -c 'dpkg --configure -a &&
    apt-get update &&
    : >"$4" &&
    bash "$1" "$2" "$3" &&
    bunx --no-install playwright install-deps chromium' \
  sh "$scripts/verify-cached-debs.sh" "$cache" "$archives" "$state/updated" \
  2>&1 | tee "$state/output" || pipe=("${PIPESTATUS[@]}")
status=${pipe[0]}
if [ "${pipe[1]}" -ne 0 ]; then
  echo "::error::install-chromium-system-libraries: tee could not save the attempt's output (exit ${pipe[1]}), so the script cannot read what apt reported"
  if [ "$status" -eq 0 ]; then status=1; fi
  exit "$status"
fi
if [ "$status" -ne 0 ]; then without_apt "$status"; fi
if grep -qxF "$kept_index" "$state/output"; then
  echo "::warning::install-chromium-system-libraries: apt-get update could not fetch every index and kept the copies on disk; its W: lines above name them"
fi

kept=("$archives"/*.deb)
if [ "${#cached[@]}" -gt 0 ]; then rm -rf -- "${cached[@]}"; fi
if [ "${#kept[@]}" -gt 0 ]; then cp "${kept[@]}" "$cache/"; fi
echo "install-chromium-system-libraries: ${#kept[@]} packages kept for the cache"
