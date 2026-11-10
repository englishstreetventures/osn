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
# CHROMIUM_APT_ROOT, unset in CI, puts apt's configuration and archive under
# another root, for scripts/tests/install-chromium-system-libraries.cli.test.ts.
set -euo pipefail

cache=${1:?usage: install-chromium-system-libraries.sh <cache dir>}
scripts=$(cd "$(dirname "$0")" && pwd)
root=${CHROMIUM_APT_ROOT:-}
archives=$root/var/cache/apt/archives

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

# Run as root, Playwright calls apt-get itself rather than through sudo.
# shellcheck disable=SC2016 # $1-$3 are the inner shell's own arguments.
sudo env "PATH=$PATH" bash "$scripts/retry.sh" 3 150 \
  sh -c 'dpkg --configure -a &&
    apt-get update &&
    bash "$1" "$2" "$3" &&
    bunx --no-install playwright install-deps chromium' \
  sh "$scripts/verify-cached-debs.sh" "$cache" "$archives"

kept=("$archives"/*.deb)
if [ "${#cached[@]}" -gt 0 ]; then rm -rf -- "${cached[@]}"; fi
if [ "${#kept[@]}" -gt 0 ]; then cp "${kept[@]}" "$cache/"; fi
echo "install-chromium-system-libraries: ${#kept[@]} packages kept for the cache"
