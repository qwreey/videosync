#!/usr/bin/env bash
# Run a browser probe inside the pinned container, with the repo bind-mounted.
#   ./run.sh node probe-throttle4.mjs
#   ./run.sh bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE=videosync-browser:latest
exec docker run --rm ${DOCKER_TTY:--it} \
  -v "$REPO:/work" \
  -p "${HOST_PORT:-8899}:8899" \
  --shm-size=1g \
  "$IMAGE" "$@"
