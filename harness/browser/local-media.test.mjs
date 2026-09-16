// local-media.mjs is what the host-attached probes stand on. A media server
// that dies or hands back the wrong bytes makes every video stall, and a
// stalled video reads as a sync or player finding.
//
//   node --test harness/browser/local-media.test.mjs     (also part of `mise run test`)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(fileURLToPath(new URL('.', import.meta.url)), 'local-media.mjs');
const SIZE = 1000;
// Every byte is its own offset (mod 251), so a body names the range it came from.
const media = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

let proc = null;
let base = '';
let dir = '';

// Resolves true once THIS child says it is listening, false if it exits first
// (a port somebody else holds). Polling the port for any 200 instead could
// pass against an unrelated server that happened to own it.
function listening(child) {
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; if (out.includes('local media on')) resolve(true); });
    child.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vs-media-'));
  const file = join(dir, 'test.mp4');
  writeFileSync(file, media);
  // This runs in `mise run test`, next to whatever else holds ports on the
  // machine, so one taken port must not fail the suite.
  for (let i = 0; i < 10; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    proc = spawn(process.execPath, [script], {
      env: { ...process.env, MEDIA: file, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (await listening(proc)) { base = `http://127.0.0.1:${port}`; return; }
    proc.kill();
  }
  throw new Error('local-media.mjs never listened on any of 10 ports');
});

after(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const get = (range) => fetch(`${base}/test.mp4`, range ? { headers: { range } } : {});

async function expectRange(range, start, end) {
  const r = await get(range);
  assert.equal(r.status, 206, range);
  assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${SIZE}`, range);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), media.subarray(start, end + 1), range);
}

it('serves the whole file without a Range', async () => {
  const r = await get();
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), media);
});

it('serves open and closed ranges', async () => {
  await expectRange('bytes=0-', 0, SIZE - 1);
  await expectRange('bytes=100-199', 100, 199);
  await expectRange('bytes=900-5000', 900, SIZE - 1);
});

it('serves a suffix range as the LAST bytes of the file', async () => {
  await expectRange('bytes=-100', SIZE - 100, SIZE - 1);
  await expectRange('bytes=-5000', 0, SIZE - 1);
});

it('refuses an unsatisfiable range with 416 and stays up', async () => {
  for (const range of [`bytes=${SIZE}-`, `bytes=${SIZE + 50}-${SIZE + 60}`, 'bytes=500-100', 'bytes=-0']) {
    const r = await get(range);
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('content-range'), `bytes */${SIZE}`, range);
    await r.arrayBuffer();
  }
  // The server is still there for the next request.
  await expectRange('bytes=0-9', 0, 9);
});
