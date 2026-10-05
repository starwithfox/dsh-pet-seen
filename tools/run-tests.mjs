/**
 * Test runner behind `npm test` (its second half, after `npm run build:test`).
 *
 * **Why this is a script and not a one-line `node --test …` in `package.json`.**
 * The suite runs with process-level test isolation **disabled**, for two
 * reasons: the restricted sandbox this project is developed in fails the
 * default per-file child processes with `EPERM` (piped stdio), and the suites
 * are written to share one process. That switch is spelled **differently on the
 * two Node lines this package declares** (`engines`: `^22.19.0 || >=24.0.0`):
 *
 * - Node 24 accepts `--test-isolation=none`;
 * - Node 22.19+ only knows `--experimental-test-isolation=none` and rejects the
 *   stable name while parsing arguments — `node: bad option:
 *   --test-isolation=none`, exit 9.
 *
 * That is not hypothetical: the first CI run of `check (22.x)` died exactly
 * there on 2026-10-05, *after* a release had been published (PL-EN-RL-01). So
 * the flag is probed at run time instead of hard-coded, and if this Node accepts
 * neither name the runner falls back to the default per-file isolation — one
 * gate command, both declared lines.
 *
 * `DSH_TEST_ISOLATION=none|default` forces the choice; it exists so the probe
 * itself can be exercised, and CI does not set it. The measured readings behind
 * this file (both lines, same command):
 *
 *     node 22.23.3  --test-isolation=none              -> bad option, exit 9
 *     node 22.23.3  --experimental-test-isolation=none -> accepted, tests run
 *     node 24.19.0  --test-isolation=none              -> accepted, tests run
 *
 * @module tools/run-tests
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Test files, in the order this suite has always run them. */
const TEST_FILES = [
  'state',
  'protocol',
  'pins',
  'credentials',
  'browser-auth',
  'integration',
  'visibility',
  'decide',
  'routes',
  'client',
  'acceptance-page',
  'session-picker',
  'gate-c-judge',
].map((name) => join('test-dist', 'tests', `${name}.test.js`))

/** Single-process switches, newest name first. */
const ISOLATION_FLAGS = ['--test-isolation=none', '--experimental-test-isolation=none']

/**
 * Does the running Node accept this switch? An unknown option is rejected while
 * parsing arguments — before any test file is read — so the exit status alone
 * answers it. Output is discarded on purpose: piped stdio is the very thing the
 * sandbox refuses.
 *
 * @param flag - command-line switch to probe.
 * @returns whether Node started with it.
 */
function accepts (flag) {
  return spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore' }).status === 0
}

const accepted = ISOLATION_FLAGS.find(accepts) ?? null
const forced = process.env.DSH_TEST_ISOLATION

if (forced !== undefined && forced !== 'none' && forced !== 'default') {
  console.error(`[run-tests] DSH_TEST_ISOLATION 只认 none / default，收到 ${JSON.stringify(forced)}`)
  process.exit(2)
}

if (forced === 'none' && accepted === null) {
  console.error(`[run-tests] node ${process.version} 两个单进程开关都不认（${ISOLATION_FLAGS.join(' / ')}）`)
  process.exit(2)
}

const isolation = forced === 'default' ? null : accepted

const args = ['--test', '--test-force-exit', '--test-timeout=60000']
if (isolation) args.push(isolation)
args.push(...TEST_FILES)

console.log(`[run-tests] node ${process.version} · ${isolation ?? '默认逐文件隔离（本机认不出单进程开关）'}`)
const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
process.exit(run.status ?? 1)
