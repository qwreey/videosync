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

// The page is a small imitation of what a real provider does when a video is
// found, because that is what an acquisition probe needs to reproduce: a site
// that autoplays, one that resumes from history, a single-page router that
// swaps the source or the whole element for the next episode, and one that
// moves on before the end (a credits countdown). All of it is off unless asked
// for, so the default page is the plain one the older probes rely on.
//
// Configuration is `?key=value` merged over sessionStorage['site'] (JSON). The
// second is what survives `followRoom`, which opens the canonical URL -- query
// stripped -- in the same tab.
//
//   autoplay   attr | meta | canplay | canplaythrough | delay   (delay: `delayMs` after canplaythrough)
//   resume     seconds to jump to at loadedmetadata, as a watch-history resume does
//   next       on `ended` (or `countdown` s before it), route to /watch/N+1 with `swap`
//   swap       src (same element, new src) | el (replace the element in one task)
//              | gap (remove it, insert the new one `gapMs` later)
//   urlAfter   ms between the media change and pushState (0: URL first)
//   mse        1: play /test-frag.mp4 through MediaSource instead of a plain src
//   ms         1: register mediaSession play/pause handlers
//
// window.__site.go(n) routes to episode n exactly as `next` would.
const PAGE = `<!doctype html><meta charset="utf-8"><title>VideoSync local media</title>
<body style="background:#111;color:#eee;font-family:sans-serif">
<h1 id="h"></h1><p><a href="/watch/1">1</a> <a href="/watch/2">2</a> <a href="/watch/3">3</a></p>
<div id="box"><video src="/test.mp4" controls preload="auto" width="640"></video></div>
<script>
(() => {
  const h = document.getElementById('h');
  h.textContent = location.pathname;
  let cfg = {};
  try { cfg = JSON.parse(sessionStorage.getItem('site') || '{}'); } catch {}
  for (const [k, v] of new URLSearchParams(location.search)) cfg[k] = v;
  const ep = () => Number((/\\/watch\\/(\\d+)/.exec(location.pathname) || [])[1] || 1);
  const srcFor = (n) => '/test.mp4?ep=' + n;
  function load(v, n) {
    if (cfg.mse === '1' && window.MediaSource) {
      const ms = new MediaSource();
      v.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', async () => {
        const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.4d401e, mp4a.40.2"');
        const buf = await (await fetch('/test-frag.mp4?ep=' + n)).arrayBuffer();
        sb.addEventListener('updateend', () => { try { ms.endOfStream(); } catch {} }, { once: true });
        sb.appendBuffer(buf);
      }, { once: true });
    } else {
      v.src = srcFor(n);
    }
  }
  function arm(v) {
    const play = () => { v.play().catch((e) => console.log('site autoplay refused: ' + e.name)); };
    const once = (t, f) => v.addEventListener(t, f, { once: true });
    const a = cfg.autoplay;
    v.autoplay = a === 'attr';
    if (a === 'meta') once('loadedmetadata', play);
    if (a === 'canplay') once('canplay', play);
    if (a === 'canplaythrough') once('canplaythrough', play);
    if (a === 'delay') once('canplaythrough', () => setTimeout(play, Number(cfg.delayMs || 1500)));
    if (Number(cfg.resume) > 0) once('loadedmetadata', () => { v.currentTime = Number(cfg.resume); });
    let gone = false;
    const onward = () => { if (!gone && cfg.next) { gone = true; go(ep() + 1); } };
    v.addEventListener('ended', onward);
    if (Number(cfg.countdown) > 0) {
      v.addEventListener('timeupdate', () => {
        if (v.duration - v.currentTime <= Number(cfg.countdown)) onward();
      });
    }
  }
  function make(n) {
    const v = document.createElement('video');
    v.controls = true; v.preload = 'auto'; v.width = 640;
    arm(v); load(v, n);
    return v;
  }
  function route(n) {
    history.pushState({}, '', '/watch/' + n + location.search);
    h.textContent = location.pathname;
  }
  function go(n) {
    const urlAfter = Number(cfg.urlAfter || 0);
    if (!urlAfter) route(n);
    const box = document.getElementById('box');
    const old = box.querySelector('video');
    const swap = cfg.swap || 'src';
    if (swap === 'src') {
      old.removeAttribute('src');
      arm(old); load(old, n);
    } else if (swap === 'el') {
      old.replaceWith(make(n));
    } else {
      old.remove();
      setTimeout(() => box.append(make(n)), Number(cfg.gapMs || 50));
    }
    if (urlAfter) setTimeout(() => route(n), urlAfter);
  }
  const v0 = document.querySelector('video');
  if (cfg.mse === '1' || cfg.autoplay || cfg.resume || cfg.next || cfg.countdown) {
    v0.removeAttribute('src'); arm(v0); load(v0, ep());
  }
  if (cfg.ms === '1' && navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('play', () => { console.log('site ms play'); document.querySelector('video').play(); });
    navigator.mediaSession.setActionHandler('pause', () => { console.log('site ms pause'); document.querySelector('video').pause(); });
  }
  window.__site = { go, cfg };
})();
</script>`;
const FRAG = process.env.MEDIA_FRAG || MEDIA.replace(/\.mp4$/, '-frag.mp4');

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/watch/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  const file = path === '/test.mp4' ? MEDIA : path === '/test-frag.mp4' ? FRAG : null;
  if (!file) { res.writeHead(404); return res.end(); }

  let size;
  try { size = statSync(file).size; } catch { res.writeHead(404); return res.end(); }
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
  const stream = createReadStream(file, { start, end });
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
