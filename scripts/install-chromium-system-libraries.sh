#!/usr/bin/env bash
# Installs what Chromium needs from the system on an Ubuntu runner, as
# `playwright install-deps chromium` does, taking the packages from
# <cache dir> where it holds them. Run it from the directory whose
# `playwright` decides the browser revision (cire/host, tools/e2e in ci.yml).
#
# usage: install-chromium-system-libraries.sh <cache dir>
#
# The runner image already has Chromium's libraries; what install-deps still
# downloads is a handful of font packages (21.9 MB on ubuntu-latest 26.04)
# from the image's apt mirror. When that mirror slowed to about 40 KB/s, the
# download ran past the step's ten minutes. So:
#
# - Every .deb in <cache dir> goes into apt's archive directory first. apt
#   takes a package from there when the file's hash matches the index and
#   downloads only the rest, so a stale or altered file is fetched again, never
#   installed.
# - apt keeps what it downloads, retries a failed fetch, and gives up on a
#   connection that sends nothing for 30 s (its default is 120 s), moving on to
#   the next mirror in the image's list.
# - The install runs under scripts/retry.sh: three attempts of 150 s each,
#   about four times the slowest normal run (40 s). apt resumes the downloads
#   an attempt left. The whole attempt runs as root, so retry.sh can stop every
#   process in it, apt-get included; a cut attempt can leave dpkg half done, so
#   each attempt first finishes that.
# - After the install, apt's archive replaces <cache dir>'s contents, for the
#   workflow to save.
set -euo pipefail

cache=${1:?usage: install-chromium-system-libraries.sh <cache dir>}
scripts=$(cd "$(dirname "$0")" && pwd)
archives=/var/cache/apt/archives

mkdir -p "$cache"
printf '%s\n' \
  'APT::Keep-Downloaded-Packages "true";' \
  'Acquire::Retries "5";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/80-ci-chromium >/dev/null

shopt -s nullglob
cached=("$cache"/*.deb)
echo "install-chromium-system-libraries: ${#cached[@]} packages from the cache"
if [ "${#cached[@]}" -gt 0 ]; then sudo cp "${cached[@]}" "$archives/"; fi

# Run as root, Playwright calls apt-get itself rather than through sudo.
sudo env "PATH=$PATH" bash "$scripts/retry.sh" 3 150 \
  sh -c 'dpkg --configure -a && bunx --no-install playwright install-deps chromium'

kept=("$archives"/*.deb)
rm -f "$cache"/*.deb
if [ "${#kept[@]}" -gt 0 ]; then cp "${kept[@]}" "$cache/"; fi
echo "install-chromium-system-libraries: ${#kept[@]} packages kept for the cache"
