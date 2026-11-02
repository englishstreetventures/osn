#!/usr/bin/env bash
# Fails the build when the envelope scene reaches the Worker bundle.
#
# The scene (`@cire/envelope/scene`, with three.js) runs only in the browser,
# loaded by the invite's module script. If any server-rendered module imports
# it, `dist/server` carries three.js on every request and the bundle-size
# budget, which only warns, does not stop it. `WebGLRenderer` is three's
# renderer class, present in any bundle that includes the scene.
set -euo pipefail

dir="${1:-.}/dist/server"
if [ ! -d "$dir" ]; then
  echo "guard-no-scene-in-server: no $dir; run astro build first" >&2
  exit 1
fi
if found=$(grep -rl WebGLRenderer "$dir"); then
  echo "guard-no-scene-in-server: the envelope scene reached the Worker bundle:" >&2
  echo "$found" >&2
  exit 1
fi
echo "guard-no-scene-in-server: dist/server has no WebGLRenderer"
