#!/usr/bin/env bash
# Run a browser probe inside the pinned container, with the repo bind-mounted.
#   ./run.sh node probe-throttle4.mjs
#   ./run.sh bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE=videosync-browser:latest
# Pass through the knobs the probes read. Without this a `TOTAL_MS=600000
# ./run.sh ...` silently runs the default and the log looks like the probe
# simply stopped early.
ENVS=()
for v in TOTAL_MS STEP_MS SILENT VIDEO_ID PORT; do
  [ -n "${!v:-}" ] && ENVS+=(-e "$v=${!v}")
done

exec docker run --rm ${DOCKER_TTY:--it} \
  "${ENVS[@]+"${ENVS[@]}"}" \
  -v "$REPO:/work" \
  -p "${HOST_PORT:-8899}:8899" \
  --shm-size=1g \
  "$IMAGE" "$@"
