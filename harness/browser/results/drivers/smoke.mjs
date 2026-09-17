// What the smoke drivers share: recording checks and steps, and deciding whether the run passed.
// Kept apart from the drivers so smoke.test.mjs can hold it to that without a browser.
import { writeFileSync } from 'node:fs';

// VideoSync.status().members is a count (client/core/src/app/bootstrap.ts), not a list. Read it
// and nothing else: the rest of status() is full of digits (a mediaKey on 127.0.0.1, positions,
// stats counters), so matching the serialised status passes whatever the roster says.
export const memberCount = (st) => (typeof st?.members === 'number' ? st.members : null);

// smokeRun(file, meta, con, { result }) -> { out, check, step, main }. main(body) runs the
// driver's steps and returns the exit code. It writes a results file whatever happens, so a step
// that throws keeps the checks and steps before it (and the error) instead of losing the run, and
// the code is non-zero when any check failed, none ran, or a step threw: printing "9/10 passed"
// and exiting 0 lets a `&&` chain or a wrapper count a failed run as a pass (the same defect F64
// fixed in probe-laftel).
//
// `file` is the name BROWSER-FINDINGS cites, so only a passing run writes it. A run that failed a
// check or aborted (on its first step, say: no browser) writes `<name>-failed.json` beside it
// instead of replacing the cited evidence. `result` (the drivers pass $RESULT) names the file
// outright, for either outcome: a bare name in the same directory, `.json` optional.
export function smokeRun(file, meta, con = console, { result = '' } = {}) {
  if (result && (/[/\\]/.test(result) || result.startsWith('.')))
    throw new Error(`RESULT must be a bare file name, not ${JSON.stringify(result)}`);
  const named = result && new URL(result.endsWith('.json') ? result : `${result}.json`, file);
  const failedFile = new URL(String(file).replace(/(\.json)?$/, '-failed.json'));
  const out = { when: new Date().toISOString(), ...meta, checks: [], steps: [] };
  const check = (name, ok, detail) => {
    out.checks.push({ name, ok: !!ok, detail });
    con.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
  };
  const step = (s) => {
    out.steps.push({ t: new Date().toISOString(), ...s });
    con.log('  ', JSON.stringify(s).slice(0, 400));
  };
  async function main(body) {
    let threw = false;
    let code = 1;
    try {
      await body();
    } catch (e) {
      threw = true;
      out.error = String(e?.stack ?? e);
      con.error(e);
    } finally {
      const passed = out.checks.filter((c) => c.ok).length;
      code = threw || out.checks.length === 0 || passed < out.checks.length ? 1 : 0;
      const to = named || (code === 0 ? file : failedFile);
      writeFileSync(to, JSON.stringify(out, null, 1));
      con.log(`\n${passed}/${out.checks.length} passed${threw ? ' (aborted)' : ''}  -> ${to.pathname ?? to}`);
    }
    return code;
  }
  return { out, check, step, main };
}
