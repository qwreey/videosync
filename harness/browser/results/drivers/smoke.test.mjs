// The smoke drivers need Helium and a server, so they cannot run here. What decides whether a
// run passed can: smoke.mjs holds it, and this pins it down without a browser.
//
//   node --test harness/browser/results/drivers/smoke.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { memberCount, smokeRun } from './smoke.mjs';

const dir = mkdtempSync(join(tmpdir(), 'smoke-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {}, error: () => {} };
const file = (name) => pathToFileURL(join(dir, name));
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));

it('a run with a failed check exits non-zero, and still writes every check', async () => {
  const f = file('failed.json');
  const run = smokeRun(f, { flags: 'x' }, quiet);
  const code = await run.main(async () => {
    run.check('one', true);
    run.check('two', false, 'why');
  });
  assert.notEqual(code, 0);
  assert.deepEqual(read(f).checks.map((c) => c.ok), [true, false]);
});

it('a run where every check passes exits 0', async () => {
  const run = smokeRun(file('ok.json'), {}, quiet);
  assert.equal(await run.main(async () => { run.check('one', true); run.check('two', 1); }), 0);
});

it('a run with no checks at all is not a pass', async () => {
  const run = smokeRun(file('empty.json'), {}, quiet);
  assert.notEqual(await run.main(async () => {}), 0);
});

it('a step that throws exits non-zero and keeps what ran before it, with the error', async () => {
  const f = file('threw.json');
  const run = smokeRun(f, {}, quiet);
  const code = await run.main(async () => {
    run.check('before the throw', true);
    run.step({ a: 'something' });
    throw new Error('no target');
  });
  assert.notEqual(code, 0);
  assert.ok(existsSync(f), 'the partial results are written');
  const got = read(f);
  assert.equal(got.checks.length, 1);
  assert.equal(got.steps.length, 1);
  assert.match(got.error, /no target/);
});

// status().members is a count (bootstrap.ts), and the rest of status() is full of 2s: a
// mediaKey on 127.0.0.1, a position, stats counters. Only the count may decide.
it('memberCount reads the count and nothing else in the status', () => {
  const one = { state: 'joined', members: 1, mediaKey: '127.0.0.1:/watch/1', positionS: 12.3, stats: { reportsSent: 2 } };
  assert.equal(memberCount(one), 1);
  assert.equal(memberCount({ ...one, members: 2 }), 2);
  assert.equal(memberCount({ err: 'x', note: '2 members' }), null);
  assert.equal(memberCount(null), null);
});
