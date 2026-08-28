#!/usr/bin/env bash
# Bring up the virtual display and the media server, then hand over.
set -euo pipefail

if [ ! -e /tmp/.X11-unix/X99 ]; then
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
fi

# Regenerate test media if the bind mount does not carry it (media/ is
# gitignored -- it is derived, not source).
if [ ! -f media/index.m3u8 ]; then
  echo "generating test media..."
  mkdir -p media
  ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=size=320x180:rate=25:duration=120" \
    -f lavfi -i "sine=frequency=440:duration=120" \
    -c:v libx264 -preset veryfast -g 50 -pix_fmt yuv420p \
    -c:a aac -b:a 48k -movflags +faststart media/test.mp4
  ffmpeg -y -loglevel error -i media/test.mp4 -c copy \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_list_size 0 \
    -hls_segment_filename media/seg%03d.ts media/index.m3u8
  [ -f media/hls.js ] || curl -sSL -o media/hls.js https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js
fi

if ! curl -sf "http://127.0.0.1:${PORT:-8899}/ctl?reset" >/dev/null 2>&1; then
  node server.mjs >/tmp/mediasrv.log 2>&1 &
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:${PORT:-8899}/ctl?reset" >/dev/null 2>&1 && break; sleep 0.1; done
fi

exec "$@"
