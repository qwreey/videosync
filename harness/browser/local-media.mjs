// A local "provider" for the host-attached probes: a plain progressive mp4
// behind pages whose path names the episode, so two paths are two media.
//
// Exists because YouTube stops serving an automated Firefox after ~40 s of
// playback -- the player resets itself, with or without the extension
// (docs/BROWSER-FINDINGS.md §19) -- so it cannot carry a long measurement.
// server.mjs is the container's HLS server and has no Range support, which a
// progressive <video> needs to seek.
//
//   ffmpeg -f lavfi -i testsrc=size=426x240:rate=25 -f lavfi -i sine=frequency=440 \
//     -t 240 -c:v libx264 -g 50 -b:v 300k -c:a aac -movflags +faststart .cache/media/test.mp4
//   node harness/browser/local-media.mjs          # http://127.0.0.1:8898/watch/1
//
// RATE_KBPS limits delivery, so a seek past the buffer costs real time.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MEDIA = process.env.MEDIA || join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '.cache', 'media', 'test.mp4');
const PORT = Number(process.env.PORT || 8898);
const RATE = Number(process.env.RATE_KBPS || 0) * 125;   // bytes per second, 0 = unlimited

const PAGE = `<!doctype html><meta charset="utf-8"><title>VideoSync local media</title>
<body style="background:#111;color:#eee;font-family:sans-serif">
<h1 id="h"></h1><p><a href="/watch/1">1</a> <a href="/watch/2">2</a> <a href="/watch/3">3</a></p>
<video src="/test.mp4" controls preload="auto" width="640"></video>
<script>document.getElementById('h').textContent = location.pathname;</script>`;

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/watch/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (path !== '/test.mp4') { res.writeHead(404); return res.end(); }

  const size = statSync(MEDIA).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  if (m && m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2]) {
    // `bytes=-N` is the LAST N bytes, not the first N+1. `bytes=-0` asks for
    // nothing, which is unsatisfiable.
    start = Number(m[2]) === 0 ? size : Math.max(size - Number(m[2]), 0);
  }
  // A start at or past the end used to reach createReadStream with start > end,
  // which throws synchronously and took the whole server down -- after which
  // every video stalls and it reads as a player finding.
  if (m && start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(m ? 206 : 200, {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
    ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  const stream = createReadStream(MEDIA, { start, end });
  // A read error ends this response, not the process.
  stream.on('error', () => res.destroy());
  if (!RATE) return stream.pipe(res);
  // Crude pacing: pause the stream whenever we are ahead of the budget.
  const t0 = Date.now();
  let sent = 0;
  stream.on('data', (chunk) => {
    sent += chunk.length;
    res.write(chunk);
    const ahead = sent / RATE * 1000 - (Date.now() - t0);
    if (ahead > 0) { stream.pause(); setTimeout(() => stream.resume(), ahead); }
  });
  stream.on('end', () => res.end());
  res.on('close', () => stream.destroy());
}).listen(PORT, '127.0.0.1', () => console.log(`local media on http://127.0.0.1:${PORT}/watch/1`));
