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
  const run = smokeRun(file('failed.json'), { flags: 'x' }, quiet);
  const code = await run.main(async () => {
    run.check('one', true);
    run.check('two', false, 'why');
  });
  assert.notEqual(code, 0);
  assert.deepEqual(read(file('failed-failed.json')).checks.map((c) => c.ok), [true, false]);
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
  const f = file('threw-failed.json');
  const run = smokeRun(file('threw.json'), {}, quiet);
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

// The default names are cited by BROWSER-FINDINGS. A run that aborts on its first step, or
// fails a check, must not replace the passing run a citation points at.
it('only a passing run writes the cited name; any other writes <name>-failed', async () => {
  const cited = file('cited.json');
  const good = smokeRun(cited, {}, quiet);
  assert.equal(await good.main(async () => { good.check('one', true); }), 0);
  assert.equal(read(cited).checks.length, 1);

  const aborted = smokeRun(cited, {}, quiet);
  await aborted.main(async () => { throw new Error('no target'); });
  const failedCheck = smokeRun(cited, {}, quiet);
  await failedCheck.main(async () => { failedCheck.check('one', false); failedCheck.check('two', true); });
  assert.deepEqual(read(cited).checks.map((c) => c.ok), [true], 'the cited run is untouched');
  assert.deepEqual(read(file('cited-failed.json')).checks.map((c) => c.ok), [false, true]);
});

it('RESULT names the file, whatever the run did', async () => {
  const cited = file('named.json');
  const good = smokeRun(cited, {}, quiet, { result: 'named-run2' });
  await good.main(async () => { good.check('one', true); });
  assert.ok(existsSync(file('named-run2.json')));
  assert.ok(!existsSync(cited));

  const bad = smokeRun(cited, {}, quiet, { result: 'named-run3.json' });
  await bad.main(async () => { throw new Error('x'); });
  assert.match(read(file('named-run3.json')).error, /x/);
  assert.ok(!existsSync(file('named-run3-failed.json')) && !existsSync(file('named-failed.json')));
});

it('a RESULT that is a path is refused, so it cannot write outside results/', () => {
  for (const result of ['../x', 'a/b', 'a\\b', '..'])
    assert.throws(() => smokeRun(file('p.json'), {}, quiet, { result }), /RESULT/);
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
