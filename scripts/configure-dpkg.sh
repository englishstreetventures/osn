#!/usr/bin/env bash
# Runs `dpkg --configure -a`, which finishes what an interrupted dpkg left half
# done, waiting up to <seconds> for another dpkg to let go of dpkg's lock.
#
# usage: configure-dpkg.sh <seconds>
#
# dpkg never waits for its lock. When another process holds it, dpkg prints
# "dpkg: error: dpkg database lock was locked by <program> process with pid
# <n>" (or the same of its frontend lock) and exits 2 at once (FILE_LOCK_NOWAIT
# in modstatdb_lock, lib/dpkg/dbmodify.c; file_lock, lib/dpkg/file.c), as it
# does on every fatal error. The holder that matters here is a dpkg that
# outlived the attempt that started it: apt-get runs dpkg in a session of its
# own (SetupSlavePtyMagic in apt's apt-pkg/deb/dpkgpm.cc calls setsid), so when
# scripts/retry.sh cuts an attempt mid-install and kills its process group,
# apt-get dies and dpkg runs on, holding the lock. Without apt-get it ends
# within seconds, having finished or failed to write to apt.
#
# Removing the lock file is always wrong (dpkg's own message says so), and
# killing that dpkg could stop it mid-write, so this script waits instead.
# When dpkg exits 2 with its own line saying the lock was held, it waits a
# second and runs dpkg again, at most <seconds> times. dpkg's stdout and stderr
# reach the log as they come; its stderr is also kept in a file, to be read.
# It prints one line when it starts waiting, one when the lock came free, and
# one when it gives up.
#
# Exit: 0 when dpkg passes; dpkg's status at once when it fails for any other
# reason, and once the lock is still held after <seconds> waits; 2 for a usage
# error; 1 when it has no file for dpkg's stderr.
#
# Tests: scripts/tests/install-chromium-system-libraries.cli.test.ts.
set -uo pipefail

usage() {
  echo "usage: configure-dpkg.sh <seconds>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
case "$1" in
  '' | *[!0-9]*) usage ;;
esac
seconds=$1

errors=$(mktemp) || exit 1
trap 'rm -f "$errors"' EXIT

# dpkg's own line for a lock another process holds (lib/dpkg/file.c, printed
# by lib/dpkg/ehandle.c): "<lock> was locked by <program> process with pid
# <n>", or "<lock> was locked by another process".
refused='^dpkg: error: .*lock was locked by '

exec 3>&1
waited=0
while :; do
  dpkg --configure -a 2>&1 1>&3 3>&- | tee "$errors" >&2
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then
    if [ "$waited" -gt 0 ]; then
      echo "configure-dpkg: dpkg's lock came free after $waited s"
    fi
    exit 0
  fi
  if [ "$status" -ne 2 ] || ! grep -q "$refused" "$errors"; then exit "$status"; fi
  if [ "$waited" -ge "$seconds" ]; then
    echo "configure-dpkg: dpkg's lock was still held after $seconds s"
    exit "$status"
  fi
  if [ "$waited" -eq 0 ]; then
    echo "configure-dpkg: waiting up to $seconds s for dpkg's lock"
  fi
  sleep 1
  waited=$((waited + 1))
done
