// Local media server with deliberate stall control.
// The point is to be able to starve the player on demand, so we can observe
// what a real MSE stall actually looks like -- the stall-inference design in
// docs/PROTOCOL.md rests on a signature that has so far only existed in a model.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8899);

// Mutable delivery policy, driven by /ctl
const policy = { delayMs: 0, delayFromSeg: 0, blockFromSeg: Infinity };

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.json': 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const segNum = (p) => {
  const m = /seg(\d+)\.ts$/.exec(p);
  return m ? Number(m[1]) : null;
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/ctl') {
    for (const [k, v] of url.searchParams) {
      if (k === 'reset') { policy.delayMs = 0; policy.delayFromSeg = 0; policy.blockFromSeg = Infinity; }
      else if (k in policy) policy[k] = Number(v);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(policy));
  }

  const file = join(ROOT, path === '/' ? 'page.html' : path.replace(/^\/+/, ''));
  try {
    await stat(file);
  } catch {
    res.writeHead(404); return res.end('not found');
  }

  const n = segNum(path);
  if (n !== null) {
    if (n >= policy.blockFromSeg) { res.writeHead(503); return res.end('blocked'); }
    if (policy.delayMs > 0 && n >= policy.delayFromSeg) await sleep(policy.delayMs);
  }

  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',           // never let the cache hide a stall
    'access-control-allow-origin': '*',
  });
  res.end(body);
}).listen(PORT, () => console.log(`media server on ${PORT}`));
