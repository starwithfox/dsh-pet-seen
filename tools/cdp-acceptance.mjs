#!/usr/bin/env node
/**
 * Autonomous browser acceptance for `dsh-pet-seen`.
 *
 * Drives a **headless Chrome over CDP** so the page-side acceptance in
 * `tools/acceptance-client-page.js` can run without a human pasting anything
 * into a console. A hand-executed gate can only ever prove that a person ran it
 * correctly once, and this round
 * lost three attempts to exactly that class of failure (a stale paste, a wrong
 * scroll by one pixel, and a human losing a race to a 2-second timer).
 *
 * The runner file is fed to the page **verbatim** via `Runtime.evaluate`, not
 * copied or re-implemented, so the headless run and the manual run execute the
 * same bytes. ROUND 1's defect slipped through precisely because a test carried
 * its own copy of the rule it was checking.
 *
 * HOW IT GETS A NOTICE
 *   A notice only exists once a run settles, so this has to outlive the turn
 *   that produced it. Run it as a **background job**: it polls
 *   `/pet-bridge/notices` every 400 ms and stages the reply off screen the
 *   moment one appears — faster than the client's 1 s poll plus its dwell, which
 *   is the only reason the counterexample can be held at all.
 *
 * USAGE
 *   node tools/cdp-acceptance.mjs [--url http://127.0.0.1:3080/] [--out report.json] [--force-out]
 *                                 [--session <sessionId>] [--session-title <text>]
 *                                 [--port 0]
 *                                 [--wait-for-notice-ms 480000] [--keep-open]
 *                                 [--cookie "<name>=<value>"] [--no-auth]
 *                                 [--no-sandbox]
 *   node tools/cdp-acceptance.mjs --gate-c [--other-session <sessionId>]
 *   node tools/cdp-acceptance.mjs --measure-only [--session <sessionId>]
 *                                 [--out measure.json] [--force-out]
 *
 * THREE MODES
 *   Default: the Gate A runner, one tab, one session — the below-fold
 *   counterexample and the positive stage, on a notice this tab is offered.
 *   `--gate-c`: open a **second tab on another session** and run the
 *   cross-session, cross-turn, multi-notice and post-dismissal counterexamples
 *   (`tools/gate-c-page.js` for the observations, `tools/gate-c-judge.js` for the
 *   verdicts). The second tab is created with `Target.createTarget`, driven on its
 *   own CDP connection, and made frontmost / background with `Page.bringToFront`,
 *   which is the only way to test "the user is looking at the other session".
 *   Without `--other-session` the driver picks whichever session in `/state` is
 *   holding the most unconfirmed notices.
 *   `--measure-only`: **read-only reconnaissance**, no scrolling and no
 *   `/seen`. It lands on the session, reads the host's open notices for it and
 *   measures each one's result group in the page, so the one hard constraint
 *   behind A2 — "is there at least a band-height of content *above* the reply"
 *   (`belowFoldFacts().stageable`, i.e. `wanted >= 0`) — is known **before** a
 *   two-minute gate run is risked. It writes its own report and exits 0 even
 *   when the material is unstageable; the numbers are the result, not a verdict.
 *
 * REPORTS ARE EVIDENCE
 *   An `--out` path that already exists is **refused** (exit 3), because the
 *   Gate A / Gate C reports are what the delivery record cites by name. Reruns
 *   must choose a new file name; `--force-out` replaces one deliberately.
 *
 * SESSION SELECTION
 *   The harness has no session deep link, so a fresh profile lands on the
 *   new-conversation placeholder rather than the most recent session. When the
 *   page does not come up with a conversation, this opens the expected session
 *   from the sidebar itself (`tools/session-picker-page.js`), matching on the
 *   row's React props first and on the title the host reports in `/state`
 *   second. If neither matches it stops and reports what the sidebar did
 *   expose, instead of clicking something that might be the wrong session.
 *
 * AUTH
 *   `GET /` on the DSH web server answers 401 unless the request carries the
 *   browser-session cookie that the process token exchange mints. A temporary
 *   Chrome profile has none, so by default this driver mints one itself from the
 *   signing secret DSH already stores for this machine in
 *   `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`), exactly
 *   as the server would: same cookie name, same signed payload, same authority.
 *   `--cookie` supplies one by hand and `--no-auth` skips the step entirely.
 *
 * PORT OWNERSHIP
 *   Chrome is started with `--remote-debugging-port=0` and the driver reads the
 *   port Chrome writes into `<profile>/DevToolsActivePort` of the temporary
 *   profile it just created. That file cannot belong to another browser, so the
 *   driver can never attach to — and navigate — a DevTools endpoint that was
 *   already listening. `--port` overrides the request and is still verified
 *   against that file.
 *
 * EXIT CODES
 *   0  every check passed
 *   1  at least one check failed
 *   2  no verdict: the scenario could not be staged (SKIP / INCONCLUSIVE)
 *   Other non-zero values are driver failures and are reported as such — "did
 *   not run" must never be mistaken for "ran and passed".
 *
 * REQUIRES
 *   Chrome cannot start under DSH's confined file modes: its Mojo IPC uses
 *   named pipes, which both read-only and workspace-write forbid
 *   (`platform_channel.cc:89 Check failed: 拒绝访问`). This needs a
 *   one-shot `danger-full-access` escalation for the launch.
 *
 * @module tools/cdp-acceptance
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSessionCookie, readSessionSecret, splitCookie } from './browser-auth.mjs'

/* ------------------------------------------------------------------ config */

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const has = (name) => argv.includes(`--${name}`)

const PAGE_URL = flag('url', 'http://127.0.0.1:3080/')
const OUT_PATH = flag('out', 'cdp-acceptance-report.json')
/**
 * Debug port to *request*. 0 lets Chrome pick a free one and report it back
 * through `DevToolsActivePort`, which is the only value this driver trusts.
 */
const REQUESTED_DEBUG_PORT = Number(flag('port', '0'))
const WAIT_FOR_NOTICE_MS = Number(flag('wait-for-notice-ms', '480000'))
const KEEP_OPEN = has('keep-open')
const FORCE_NO_SANDBOX = has('no-sandbox')
const EXPLICIT_COOKIE = flag('cookie', null)
const SKIP_AUTH = has('no-auth')
/**
 * Write the report, refusing to clobber an existing one.
 *
 * The Gate A and Gate C reports *are* the evidence: the delivery record and the
 * hand-off index point at them by name. A rerun that silently replaced one would
 * leave a document citing a verdict no file backs, so overwriting is opt-in.
 *
 * @param report - the report body to serialize.
 * @returns whether the file was written.
 */
function writeReport(report) {
  if (!has('force-out') && existsSync(OUT_PATH)) {
    log(`refusing to overwrite existing report ${OUT_PATH}`)
    log('  use a new --out file name, or pass --force-out to replace it deliberately')
    return false
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return true
}
/** Lifetime of a self-minted browser-session cookie, in days. */
const COOKIE_DAYS = Number(flag('cookie-days', '1'))
/** Discovered session the page is expected to be showing; asserted when given. */
const EXPECTED_SESSION = flag('session', process.env.DSH_SESSION_ID ?? null)
/**
 * Gate C mode: the cross-session / cross-turn / post-dismissal counterexamples,
 * driven from a second tab instead of the single-session Gate A runner.
 */
const GATE_C = has('gate-c')
/** Session the second tab should open; discovered from the host when omitted. */
const OTHER_SESSION = flag('other-session', null)
/**
 * Opt in to the "visible but unfocused" phase.
 *
 * Off by default because it cannot establish its own premise on this machine: the
 * driver's Chrome window really does hold the desktop focus, so with focus
 * emulation off the page still reports `focused=true` — and a focused page looking
 * at an unconfirmed reply *correctly* confirms it, which spends a notice the other
 * phases need. Measured live: that is exactly what happened, and the judge
 * reported `INCONCLUSIVE` rather than inventing a verdict either way. The plan
 * asks for "blurred **or** background", and the background half is phase C1.
 */
const GATE_C_BLUR = has('gate-c-blur')
/**
 * Read-only reconnaissance: measure the material without driving anything.
 *
 * A2's one hard constraint is that the content **above** the reply must be at
 * least a band-height (`belowFoldFacts().stageable`), and that is a property of
 * the live session, not of the runner. Measuring it here turns "run the gate and
 * find out it was a SKIP" into a few seconds of reading, which matters while a
 * notice is live and can still be re-minted.
 */
const MEASURE_ONLY = has('measure-only')

/** The runner under test. Loaded from disk so it cannot drift from the manual path. */
const RUNNER_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'acceptance-client-page.js')

/** Page-side session selection; injected verbatim, same reason as the runner. */
const PICKER_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'session-picker-page.js')

/** Chrome candidates, most preferred first. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const log = (...parts) => console.log(`[cdp-accept] ${new Date().toISOString().slice(11, 23)}`, ...parts)
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/* ------------------------------------------------------------- cdp plumbing */

/** Reject a promise that has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Open a CDP session on one target.
 *
 * @param url - the target's `webSocketDebuggerUrl`.
 * @returns a small client: `send`, `on`, `close`.
 */
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    const listeners = new Set()
    let nextId = 1

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId
          nextId += 1
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        on(listener) { listeners.add(listener) },
        close() { try { socket.close() } catch { /* already gone */ } },
      })
    })
    socket.addEventListener('error', () => reject(new Error(`CDP socket failed to open: ${url}`)))
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = pending.get(message.id)
        if (entry === undefined) return
        pending.delete(message.id)
        if (message.error !== undefined) {
          entry.rej(new Error(`${message.error.message ?? 'cdp error'} (code ${message.error.code ?? '?'})`))
        } else {
          entry.res(message.result)
        }
        return
      }
      for (const listener of listeners) listener(message)
    })
  })
}

/** Evaluate in the page, surfacing exceptions as errors. */
async function evaluate(cdp, expression, options = {}) {
  const result = await withTimeout(
    cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise === true,
      returnByValue: true,
      userGesture: true,
    }),
    options.timeoutMs ?? 60000,
    'Runtime.evaluate',
  )
  if (result.exceptionDetails !== undefined) {
    const description = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'unknown exception'
    throw new Error(`page evaluation threw: ${description}`)
  }
  return result.result === undefined ? undefined : result.result.value
}

/** GET JSON from one DevTools HTTP endpoint. */
async function cdpJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
  return await response.json()
}

/* -------------------------------------------------------------------- auth */

/**
 * The browser-session cookie this driver should present, or null when auth is
 * deliberately skipped.
 *
 * The cookie is minted from the same durable signing secret DSH keeps for this
 * machine; see `tools/browser-auth.mjs` for why that is not a privilege
 * escalation. `--cookie` supplies one by hand instead.
 *
 * @returns a `name=value` cookie pair, or null.
 */
function resolveCookie() {
  if (SKIP_AUTH) return null
  if (EXPLICIT_COOKIE !== null) return EXPLICIT_COOKIE
  const issuedAt = Date.now()
  return buildSessionCookie({
    pageUrl: PAGE_URL,
    secret: readSessionSecret(),
    issuedAt,
    expiresAt: issuedAt + COOKIE_DAYS * 24 * 60 * 60 * 1000,
  })
}

/* ------------------------------------------------------------- chrome launch */

/** First existing Chrome/Edge binary. */
function findChrome() {
  const override = flag('chrome', null)
  const candidates = override === null ? CHROME_CANDIDATES : [override]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no browser found; looked at:\n  ${candidates.join('\n  ')}`)
}

/**
 * Kill a launched browser and delete the profile it was given.
 *
 * Called on every failure path: a leftover browser would keep holding the
 * profile directory and could be mistaken for "the one we started" by a later
 * run.
 *
 * @param pid - the launched process id, when one exists.
 * @param profile - the temporary profile directory, when one exists.
 */
function killBrowser(pid, profile) {
  if (typeof pid === 'number') {
    if (process.platform === 'win32') {
      // Chrome is launched detached, so its renderer/GPU children outlive a
      // plain SIGKILL of the parent; /T takes the whole tree.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  if (typeof profile === 'string' && profile !== '') {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
  }
}

/**
 * Start a headless browser that is provably ours and wait for its endpoint.
 *
 * @param extraArgs - appended arguments (used for the `--no-sandbox` retry).
 * @returns the pid, the temporary profile, and the port Chrome chose.
 */
async function launchBrowser(extraArgs) {
  const binary = findChrome()
  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-cdp-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-extensions',
    '--mute-audio',
    `--remote-debugging-port=${REQUESTED_DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000',
    ...extraArgs,
    'about:blank',
  ]
  log(`launching ${binary}`)
  log(`  profile ${profile}`)
  log(`  requested debug port ${REQUESTED_DEBUG_PORT} (0 = let Chrome choose)`)
  // `stdio: 'ignore'` on purpose: a piped child cannot be spawned under the
  // confined file modes, and nothing useful is printed on the happy path.
  const child = spawn(binary, args, { detached: true, stdio: 'ignore' })
  child.unref()

  /*
   * Chrome writes the port it actually bound into `DevToolsActivePort` inside
   * the profile directory *we* just created, so this both discovers the port
   * and proves the endpoint belongs to this launch. A fixed port would instead
   * attach to whatever DevTools server happened to be listening there.
   */
  const activePath = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 30000
  let lastError = null
  while (Date.now() < deadline) {
    await sleep(300)
    try {
      const lines = readFileSync(activePath, 'utf8').split('\n')
      const port = Number(lines[0])
      if (!Number.isInteger(port) || port <= 0) throw new Error('DevToolsActivePort has no usable port yet')
      if (REQUESTED_DEBUG_PORT !== 0 && port !== REQUESTED_DEBUG_PORT) {
        throw new Error(`Chrome bound port ${port}, not the requested ${REQUESTED_DEBUG_PORT}`)
      }
      await cdpJson(port, '/json/version')
      log(`DevTools endpoint up on 127.0.0.1:${port} (from our own DevToolsActivePort)`)
      return { pid: child.pid, profile, port }
    } catch (error) {
      lastError = error
    }
  }
  killBrowser(child.pid, profile)
  throw new Error(`browser did not expose DevTools within 30 s (${String(lastError)})`)
}

/**
 * Pick the page target to drive: the `about:blank` this launch created.
 *
 * @param port - the port proven to belong to this launch.
 * @returns the DevTools target descriptor.
 */
async function findPageTarget(port) {
  const targets = await cdpJson(port, '/json/list')
  const pages = targets.filter((target) => target.type === 'page')
  if (pages.length === 0) throw new Error('no page target in the browser we launched')
  const fresh = pages.find((target) => target.url === 'about:blank')
  if (fresh === undefined) {
    throw new Error(`the browser we launched has no fresh about:blank page (pages: ${pages.map((page) => page.url).join(', ')})`)
  }
  return fresh
}

/**
 * Describe the page's session list, for when it is showing the wrong session.
 *
 * The harness has no session deep link, so a fresh profile lands wherever the
 * app decides. When that is not the session a notice will be minted for, the
 * run can never succeed — and guessing at a selector is how a gate turns into
 * fiction. This reports what the sidebar actually exposes instead.
 *
 * @param cdp - the session to evaluate on.
 * @returns a short human-readable summary.
 */
async function describeSessions(cdp) {
  try {
    // Same real-DOM lookup the opener uses: the id comes from the row's React
    // fiber props, because the sidebar exposes no session attribute at all.
    const { rows } = await openSessionById(cdp, null)
    return JSON.stringify(rows)
  } catch (error) {
    return `(could not read the session list: ${String(error)})`
  }
}
/**
 * Snapshot what the page is actually showing, for when it never becomes ready.
 *
 * The readiness gate needs three independent things (`[data-chat-flow]`, a
 * `tab-id` the pet client mints in `apply()`, and at least one `[data-chat-turn]`).
 * Reporting only "never became ready" cannot say which one is missing, so the
 * dump records all three plus the visible text, so the next step is driven by
 * evidence instead of a guessed selector.
 *
 * @param cdp - the session to evaluate on.
 * @returns a plain object; `{ error }` when even the dump failed.
 */
async function describePage(cdp) {
  try {
    const raw = await evaluate(cdp, `JSON.stringify({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      counts: {
        chatFlow: document.querySelectorAll('[data-chat-flow]').length,
        chatTurn: document.querySelectorAll('[data-chat-turn]').length,
        conversationScroll: document.querySelectorAll('[data-conversation-scroll]').length,
        assistantStep: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
        bodyChildren: document.body === null ? 0 : document.body.children.length,
      },
      tabId: sessionStorage.getItem('dsh-pet-seen:tab-id'),
      sessionStorageKeys: Object.keys(sessionStorage),
      bodyText: (document.body === null ? '' : document.body.innerText).slice(0, 800),
    })`)
    return raw === null ? { error: 'the page returned nothing' } : JSON.parse(raw)
  } catch (error) {
    return { error: String(error) }
  }
}

/**
 * Wait until the page shows a conversation *and* has the pet client applied.
 *
 * Three things are required and each one has been observed to fail on its own:
 * `[data-chat-flow]` (the app rendered a conversation), a `tab-id` (the pet
 * client ran `apply()`), and at least one `[data-chat-turn]` (the conversation
 * has content). The progress line exists because a silent 90 s loop gives no
 * way to tell which one is missing.
 *
 * @param cdp - the session to evaluate on.
 * @param timeoutMs - how long to keep polling.
 * @returns `{ ready, lastPoll }`; a 401 is thrown, never treated as "booting".
 */
async function waitForPageReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastPoll = null
  let lastPollLog = 0
  while (Date.now() < deadline) {
    await sleep(500)
    try {
      const state = await evaluate(cdp, `JSON.stringify({
        flow: document.querySelector('[data-chat-flow]') !== null,
        tab: sessionStorage.getItem('dsh-pet-seen:tab-id'),
        turns: document.querySelectorAll('[data-chat-turn]').length,
        ready: document.readyState,
        body: document.body === null ? '' : document.body.innerText.slice(0, 120),
      })`)
      const parsed = JSON.parse(state ?? '{}')
      lastPoll = parsed
      if (Date.now() - lastPollLog > 10000) {
        lastPollLog = Date.now()
        log(`waiting for page: ${JSON.stringify({
          readyState: parsed.ready,
          flow: parsed.flow,
          tabId: parsed.tab ?? null,
          turns: parsed.turns,
        })}`)
      }
      if (typeof parsed.body === 'string' && parsed.body.includes('authentication required')) {
        throw new Error(
          'dsh web answered 401: the page needs a browser-session cookie.'
          + ' Pass --cookie "<name>=<value>" (copy it from a working tab) or fix the stored secret.',
        )
      }
      if (parsed.flow === true && typeof parsed.tab === 'string' && parsed.tab !== '' && parsed.turns > 0) {
        return { ready: true, lastPoll: parsed }
      }
    } catch (error) {
      // A 401 is fatal and must not be retried; everything else is the app booting.
      if (String(error).includes('401')) throw error
    }
  }
  return { ready: false, lastPoll }
}

/**
 * Open one session from the sidebar, by id, using the real DOM.
 *
 * The page-side half lives in `session-picker-page.js` and is injected
 * **verbatim**, for the same reason `acceptance-client-page.js` is: the file a
 * test can drive is the file the browser runs, so the two cannot drift.
 *
 * @param cdp - the session to evaluate on.
 * @param sessionId - the session to open.
 * @param title - host-reported title, used only when the fiber lookup misses.
 * @returns the picker's result object.
 */
async function openSessionById(cdp, sessionId, title = null) {
  await evaluate(cdp, `window.__petSessionPickRequest = ${JSON.stringify({
    sessionId,
    title,
    open: true,
  })}`)
  const source = readFileSync(PICKER_PATH, 'utf8')
  const raw = await evaluate(cdp, source, { awaitPromise: true, timeoutMs: 20000 })
  return raw === null ? { clicked: false, rows: [], matchedBy: null } : JSON.parse(raw)
}

/**
 * Ask the running plugin what it calls the session we are about to open.
 *
 * `/state` is the host's own view of its sessions (`{ sessionId, title, ... }`),
 * so the sidebar can be matched on data the host supplied instead of on a guess
 * about how the UI names things. Any failure is non-fatal: the fiber lookup does
 * not need it, and the picker reports which strategy it used.
 *
 * @param sessionId - the session to look up.
 * @returns the title, or null when unavailable.
 */
async function fetchSessionTitle(sessionId) {
  if (sessionId === null) return null
  try {
    const bridge = JSON.parse(readFileSync(join(homedir(), '.dsh', 'pet-bridge.json'), 'utf8'))
    const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${bridge.token}`)
    if (!response.ok) return null
    const state = await response.json()
    const session = (state.sessions ?? []).find((entry) => entry.sessionId === sessionId)
    return typeof session?.title === 'string' && session.title !== '' ? session.title : null
  } catch {
    return null
  }
}

/**
 * Which session is this tab actually showing?
 *
 * The client announces it in its own `/visibility` request, so a synthetic focus
 * event makes it identify itself. This duplicates a little of the runner's
 * discovery on purpose: a notice for the wrong session never arrives, and
 * without this check the run would burn its whole wait budget before saying so.
 * The patch is removed again so the runner sees a clean `window.fetch`.
 *
 * @param cdp - the session to evaluate on.
 * @returns the session id, or null when the client never spoke.
 */
async function probeSession(cdp) {
  return await evaluate(cdp, `(async () => {
    const original = window.fetch
    const seen = []
    window.fetch = function (input, init) {
      try {
        const url = String(input !== null && typeof input === 'object' && 'url' in input ? input.url : input)
        if (url.indexOf('pet-bridge') !== -1) {
          const match = /[?&]sessionId=([^&]+)/.exec(url)
          if (match !== null) seen.push(decodeURIComponent(match[1]))
          else if (init !== undefined && typeof init.body === 'string') {
            try {
              const parsed = JSON.parse(init.body)
              if (typeof parsed.sessionId === 'string' && parsed.sessionId !== '') seen.push(parsed.sessionId)
            } catch { /* not JSON */ }
          }
        }
      } catch { /* never break the page */ }
      return original.apply(this, arguments)
    }
    try {
      window.dispatchEvent(new Event('focus'))
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && seen.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return seen[0] === undefined ? null : seen[0]
    } finally {
      window.fetch = original
    }
  })()`, { awaitPromise: true, timeoutMs: 20000 })
}

/* ----------------------------------------------------------- measure-only */

/** Flow items / kinds the *shipping* client measures for a turn's result. */
const RESULT_ITEM_KINDS = ['assistant-step', 'turn-error', 'turn-max-tokens']
/** The runner's first below-fold margin (`BELOW_FOLD_MARGINS_PX[0]`). */
const BELOW_FOLD_MARGIN_PX = 16

/**
 * Measure one turn's reply against the visible band, read-only.
 *
 * Mirrors `belowFoldFacts()` in `acceptance-client-page.js` and
 * `turnResultBox()` in `src/client/visibility.ts`: same selectors, same union
 * rule, same arithmetic. It is a mirror on purpose — the point is to predict
 * what the gate will attempt, so a *different* theory of the layout would defeat
 * the exercise — and every figure that decides the prediction is printed next to
 * the prediction itself, so a mismatch is visible rather than silent.
 *
 * @param cdp - the page connection.
 * @param turn - the turn whose reply the notice points at.
 * @returns the geometry, or `{ error }`.
 */
async function measureNoticeGeometry(cdp, turn) {
  const raw = await evaluate(cdp, `(() => {
    const turn = ${JSON.stringify(turn)}
    const active = document.querySelector("[data-phase='active']")
    const scope = active ?? document
    const scroll = scope.querySelector('[data-conversation-scroll]') ?? scope.querySelector('[data-chat-flow]')
    if (scroll === null) return JSON.stringify({ error: 'no scroll container in the page' })
    const items = [...scope.querySelectorAll('[data-chat-turn="' + turn + '"]')]
    /* Union of the rendered (non-zero) items of one kind, most authoritative first. */
    const union = (elements) => {
      let top = Infinity
      let bottom = -Infinity
      for (const element of elements) {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (rect.top < top) top = rect.top
        if (rect.bottom > bottom) bottom = rect.bottom
      }
      return bottom <= top ? null : { top, bottom }
    }
    let reply = null
    let replyKind = null
    for (const kind of ${JSON.stringify(RESULT_ITEM_KINDS)}) {
      const box = union(items.filter((element) => element.getAttribute('data-chat-flow-kind') === kind))
      if (box !== null && box !== undefined) { reply = box; replyKind = kind; break }
    }
    const others = union(items.filter((element) => !${JSON.stringify(RESULT_ITEM_KINDS)}.includes(element.getAttribute('data-chat-flow-kind'))))
    const rect = scroll.getBoundingClientRect()
    const viewportTop = typeof window.scrollY === 'number' ? window.scrollY : 0
    const bandTop = Math.max(rect.top, viewportTop)
    const bandBottom = Math.min(rect.bottom, viewportTop + window.innerHeight)
    const bandHeight = Math.max(0, bandBottom - bandTop)
    if (reply === null) {
      return JSON.stringify({
        turn, replyKind: null, bandHeight: Math.round(bandHeight),
        renderedKinds: items.map((element) => element.getAttribute('data-chat-flow-kind')),
        reason: 'this turn renders no result row, so it can never be watched at all',
      })
    }
    /* Content coordinates: same transformation the runner uses. */
    const contentY = (viewportY) => viewportY - rect.top + scroll.scrollTop
    const maxScrollTop = Math.max(0, (scroll.scrollHeight ?? 0) - (scroll.clientHeight ?? 0))
    const wanted = Math.round(contentY(reply.top) - bandHeight - ${String(BELOW_FOLD_MARGIN_PX)})
    return JSON.stringify({
      turn,
      replyKind,
      replyHeight: Math.round(reply.bottom - reply.top),
      bandHeight: Math.round(bandHeight),
      currentScrollTop: Math.round(scroll.scrollTop),
      maxScrollTop: Math.round(maxScrollTop),
      replyTopContentY: Math.round(contentY(reply.top)),
      requiredScrollTop: wanted,
      clampedTo: Math.max(0, Math.min(maxScrollTop, wanted)),
      roomAboveShort: Math.max(0, -wanted),
      /* The gate's own hard constraint, computed exactly as the runner computes it. */
      stageable: wanted >= 0,
      otherRowKinds: items
        .filter((element) => !${JSON.stringify(RESULT_ITEM_KINDS)}.includes(element.getAttribute('data-chat-flow-kind')))
        .map((element) => element.getAttribute('data-chat-flow-kind')),
      otherRowOverlap: others === null ? null : Math.round(Math.min(others.bottom, bandBottom) - Math.max(others.top, bandTop)),
    })
  })()`)
  return JSON.parse(raw ?? '{}')
}

/**
 * The `--measure-only` run: report the material's geometry, change nothing.
 *
 * @param context - the tab connection plus the identifiers already asserted.
 * @returns the process exit code: 0 measured (even when unusable), 3 driver error.
 */
async function runMeasureOnly(context) {
  const { cdp, startedAt, expectedSession, ourTabId } = context
  const checks = []
  const record = (id, verdict, detail) => checks.push({ id, verdict, detail })
  const bridge = JSON.parse(readFileSync(join(homedir(), '.dsh', 'pet-bridge.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${encodeURIComponent(bridge.token)}`)
  const state = response.ok ? await response.json() : null
  if (state === null) {
    log('measure-only: GET /state did not answer')
    return 3
  }
  const open = (state.notices ?? [])
    .filter((notice) => notice.sessionId === expectedSession)
    .filter((notice) => notice.state === 'pending' || notice.state === 'shown')
  const noticeRows = []
  for (const notice of open) {
    const turn = Number(notice.targetTurnRef)
    const geometry = Number.isSafeInteger(turn) ? await measureNoticeGeometry(cdp, turn) : { error: 'no usable targetTurnRef' }
    noticeRows.push({ noticeId: notice.noticeId, turn: Number.isSafeInteger(turn) ? turn : null, state: notice.state, geometry })
    log(`notice ${String(notice.noticeId).slice(0, 8)} turn=${String(notice.targetTurnRef)} (${String(notice.state)}): `
      + (geometry.error === undefined
        ? `reply ${String(geometry.replyHeight)}px vs band ${String(geometry.bandHeight)}px,`
          + ` wanted scrollTop ${String(geometry.requiredScrollTop)} of max ${String(geometry.maxScrollTop)},`
          + ` stageable=${String(geometry.stageable)}`
          + (geometry.roomAboveShort > 0 ? ` (content above is ${String(geometry.roomAboveShort)}px short)` : '')
          + `, other rows: ${(geometry.otherRowKinds ?? []).join(', ') || '(none)'}`
        : String(geometry.error)))
  }
  const stageable = noticeRows.filter((row) => row.geometry.stageable === true)
  record('M0-session', noticeRows.length > 0 ? 'PASS' : 'SKIP',
    `${noticeRows.length} open notice(s) for ${expectedSession}`)
  record('M1-stageable', stageable.length > 0 ? 'PASS' : 'FAIL',
    stageable.length > 0
      ? `${stageable.length} of ${noticeRows.length} notice(s) can be staged below the fold: `
        + stageable.map((row) => `turn ${String(row.turn)}:${String(row.noticeId).slice(0, 8)}`).join(', ')
      : 'no open notice has a band-height of content above its reply, so A2 (and therefore A3) cannot be built')
  const report = {
    verdict: stageable.length > 0 ? 'MATERIAL-OK' : 'MATERIAL-UNSTAGEABLE',
    mode: 'measure-only',
    startedAt,
    finishedAt: new Date().toISOString(),
    pageUrl: PAGE_URL,
    debugPort: context.port,
    sessionId: expectedSession,
    ourTabId,
    checks,
    notices: noticeRows,
    console: context.consoleLines,
  }
  const wrote = writeReport(report)
  log('================ SUMMARY ================')
  for (const check of checks) log(`${String(check.verdict).padEnd(13)} ${check.id} :: ${check.detail}`)
  log(`VERDICT: ${report.verdict}`)
  if (!wrote) return 3
  log(`report written to ${OUT_PATH}`)
  return 0
}

/* ------------------------------------------------------------------ gate C */

/** Gate C page primitives, injected into the second tab verbatim. */
const GATE_C_PAGE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'gate-c-page.js')
/** Gate C verdict rules, injected verbatim so the page and its test run one file. */
const GATE_C_JUDGE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'gate-c-judge.js')

/**
 * Gate C: the counterexamples that need a second session and a second tab.
 *
 * Gate A (`acceptance-client-page.js`) settles the rule inside one session. What
 * it cannot reach is everything Gate C asks beyond one session: a notice for
 * another session while the user is looking at this one, a visible page whose
 * window is not focused, a notice whose turn is not the one on screen, two
 * unconfirmed notices in the same session, and a popup the user has closed. All
 * of those need the driver to decide *which tab is in front* and *whether focus
 * emulation is on* — a page cannot do either to itself.
 *
 * The division of labour is deliberate: the driver only sequences and harvests
 * (baseline, prepare, hold, read back), and every verdict comes from
 * `gate-c-judge.js` fed with the raw numbers, so "the scenario was never built"
 * cannot be written down as "the product failed".
 *
 * @param context - the tab A connection plus the identifiers already asserted.
 * @returns the process exit code: 0 all passed, 1 a check failed, 2 unproven.
 */
async function runGateC(context) {
  const { cdp, port, consoleLines, startedAt, expectedSession, cookie, tabAId } = context
  const pageSource = readFileSync(GATE_C_PAGE_PATH, 'utf8')
  const judgeSource = readFileSync(GATE_C_JUDGE_PATH, 'utf8')
  const pageVersion = /GATE_C_VERSION = '([^']+)'/.exec(pageSource)?.[1] ?? 'unknown'
  const judgeVersion = /JUDGE_VERSION = '([^']+)'/.exec(judgeSource)?.[1] ?? 'unknown'
  log(`gate C page ${pageVersion}, judge ${judgeVersion}`)
  const checks = []
  const observations = { dwellMs: null, target: null, phases: [], notes: [] }
  const record = (id, verdict, detail) => {
    checks.push({ id, verdict, detail })
    log(`${String(verdict).padEnd(13)} ${id} :: ${detail}`)
  }

  const bridge = JSON.parse(readFileSync(join(homedir(), '.dsh', 'pet-bridge.json'), 'utf8'))
  /** The host snapshot. The token is interpolated into the URL and never logged. */
  const hostState = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${encodeURIComponent(bridge.token)}`)
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }
  /** The pet's own acknowledgement call, the one a manual close makes. */
  const hostAck = async (noticeId, action) => {
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, token: bridge.token, noticeId, action }),
      })
      const payload = await response.json().catch(() => null)
      return {
        status: response.status,
        ok: payload === null ? null : payload.ok === true,
        state: payload === null ? null : (payload.state ?? null),
      }
    } catch (error) {
      return { status: null, ok: null, state: null, error: String(error) }
    }
  }

  let cdpB = null
  try {
    /* ------------------------------------------------ material: session B */

    const state = await hostState()
    if (state === null) {
      record('C0-host-state', 'FAIL', 'GET /state on the control port did not answer')
      return 1
    }
    const offered = (state.notices ?? []).filter((notice) => notice.state === 'pending' || notice.state === 'shown')
    const groups = new Map()
    for (const notice of offered) {
      if (notice.sessionId === expectedSession) continue
      if (!groups.has(notice.sessionId)) groups.set(notice.sessionId, [])
      groups.get(notice.sessionId).push(notice)
    }
    let otherSession = OTHER_SESSION
    if (otherSession === null) {
      const ranked = [...groups.entries()].sort((left, right) => right[1].length - left[1].length)
      if (ranked.length > 0) otherSession = ranked[0][0]
    }
    /*
     * Oldest completion first, matching the order `/pet-bridge/notices` hands the
     * page. The client walks that offer oldest-first and watches the first
     * candidate whose result is on screen (`selectWatchTarget`), so every phase
     * below picks its subject out of this array in that same order; sorting it
     * newest-first is what made the first live run judge a positive phase against
     * a notice the page was never watching.
     */
    let material = [...(otherSession === null ? [] : (groups.get(otherSession) ?? []))]
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0))
    record('C0-material',
      material.length >= 3 ? 'PASS' : (material.length >= 1 ? 'SKIP' : 'SKIP'),
      otherSession === null
        ? `no other session holds an unconfirmed notice (${offered.length} open notice(s) overall), so there is no material for a cross-session counterexample`
        : `session ${otherSession} holds ${material.length} unconfirmed notice(s): `
          + (material.map((notice) => `${String(notice.targetTurnRef)}:${String(notice.noticeId).slice(0, 8)}:${notice.state}`).join(', ') || '(none)'))
    if (otherSession === null || material.length === 0) return 2
    if (material.length < 3) {
      observations.notes.push(`only ${material.length} unconfirmed notice(s) in ${otherSession}; the multi-notice and post-dismissal phases need three`)
    }

    /* ------------------------------------------------------ material: tab B */

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
    /*
     * A freshly created tab is the active one, and this one is about to show a
     * session holding unconfirmed notices whose replies are already on screen.
     * Left in front for the few seconds the setup takes, its own client would
     * confirm the newest notice before the first phase even starts — and every
     * "it was not observed" claim afterwards would be about a notice that had
     * already been read. Bring tab A back to the front *before* anything else, so
     * the second tab is hidden for the whole of its setup.
     */
    await cdp.send('Page.bringToFront')
    const targets = await cdpJson(port, '/json/list')
    const entry = targets.find((each) => each.id === created.targetId)
    if (entry === undefined) throw new Error('the second tab was created but never appeared in /json/list')
    cdpB = await withTimeout(connectCdp(entry.webSocketDebuggerUrl), 15000, 'CDP connect (gate C tab)')
    cdpB.on((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails ?? {}
        consoleLines.push(`[gate-c exception] ${details.exception?.description ?? details.text ?? 'unknown'}`)
        return
      }
      if (message.method !== 'Runtime.consoleAPICalled') return
      const text = (message.params.args ?? [])
        .map((arg) => (arg.value === undefined ? `<${arg.type}>` : String(arg.value)))
        .join(' ')
      consoleLines.push(text)
      console.log(text)
    })
    await cdpB.send('Runtime.enable')
    await cdpB.send('Page.enable')
    await cdpB.send('Page.setBypassCSP', { enabled: true })
    if (cookie !== null) {
      const { name, value } = splitCookie(cookie)
      await cdpB.send('Network.enable')
      await cdpB.send('Network.setCookie', { url: PAGE_URL, name, value })
    }
    await cdpB.send('Page.navigate', { url: PAGE_URL })
    const tabBReady = await waitForPageReady(cdpB, 90000)
    if (!tabBReady.ready) {
      throw new Error('the gate C tab never rendered a conversation'
        + ` (flow=${tabBReady.lastPoll?.flow} tabId=${tabBReady.lastPoll?.tab ?? null} turns=${tabBReady.lastPoll?.turns})`)
    }
    await cdpB.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    /*
     * A second tab of the *same profile* does not land on the new-conversation
     * placeholder the way the first one did: the harness remembers the last open
     * session, so this tab comes up already showing tab A's session and the ready
     * gate is satisfied. Clicking through the sidebar is therefore not optional —
     * the session has to be *asserted*, not assumed, or both tabs measure the same
     * conversation and every cross-session claim is about nothing.
     */
    let sessionB = await probeSession(cdpB)
    if (sessionB !== otherSession) {
      const title = await fetchSessionTitle(otherSession)
      if (title !== null) log(`host calls ${otherSession} "${title}"`)
      const picked = await openSessionById(cdpB, otherSession, title)
      log(`gate C session pick: ${JSON.stringify({
        matchedBy: picked.matchedBy,
        clicked: picked.clicked,
        rows: picked.rows?.length ?? 0,
      })}`)
      if (picked.clicked) {
        const afterPick = await waitForPageReady(cdpB, 60000)
        if (!afterPick.ready) {
          throw new Error('the gate C tab did not render the other session after the picker clicked it'
            + ` (flow=${afterPick.lastPoll?.flow} turns=${afterPick.lastPoll?.turns})`)
        }
      }
      sessionB = await probeSession(cdpB)
    }
    const tabBId = await evaluate(cdpB, `sessionStorage.getItem('dsh-pet-seen:tab-id')`)
    record('DRIVER-two-tabs',
      sessionB === otherSession && typeof tabBId === 'string' && tabBId !== tabAId ? 'PASS' : 'FAIL',
      `tab A ${String(tabAId)} on ${expectedSession}; tab B ${String(tabBId)} on ${String(sessionB)} (wanted ${otherSession})`)
    if (sessionB !== otherSession) return 1

    await evaluate(cdpB, `window.__petGateCConfig = ${JSON.stringify({
      settleMs: 400,
      dwellFallbackMs: 1500,
      offBandMarginPx: 16,
    })}`)
    await evaluate(cdpB, pageSource)
    await evaluate(cdpB, judgeSource)

    /* ------------------------------------------------------------- helpers */

    const asJson = async (expression, options) => JSON.parse(await evaluate(cdpB, expression, options))
    const awaitJson = async (expression) => asJson(`(async () => JSON.stringify(${expression}))()`, { awaitPromise: true })
    const pageState = async () => asJson('JSON.stringify(window.__petGateC.state())')
    const pageNotices = async (sessionId) => awaitJson(`await window.__petGateC.notices(${JSON.stringify(sessionId)})`)
    const pageSeen = async (noticeId) => asJson(`JSON.stringify(window.__petGateC.seenPosts(${JSON.stringify(noticeId)}))`)
    const pageSnapshot = async (turn) => asJson(`JSON.stringify(window.__petGateC.snapshot(${turn}))`)
    /** What the page's own `selectWatchTarget` rule makes of the current offer. */
    const pageWatch = async (sessionId) => awaitJson(`await window.__petGateC.watchMirror(${JSON.stringify(sessionId)})`)
    const parkInBand = async (turn) => awaitJson(`await window.__petGateC.parkInBand(${turn})`)
    const parkAtBandTop = async (turn) => awaitJson(`await window.__petGateC.parkAtBandTop(${turn})`)
    const revealTurn = async (turn) => awaitJson(`await window.__petGateC.revealTurn(${turn})`)
    const nudgeFocus = async () => awaitJson('await window.__petGateC.nudgeFocus()')
    const setFocusEmulation = async (enabled) => {
      await cdpB.send('Emulation.setFocusEmulationEnabled', { enabled })
    }
    const hostNotice = async (noticeId) => {
      const snapshot = await hostState()
      const found = (snapshot?.notices ?? []).find((each) => each.noticeId === noticeId) ?? null
      return found === null
        ? { state: null, seenAt: null, delivered: null }
        : { state: found.state, seenAt: found.seenAt, delivered: found.delivered }
    }
    const offeredIds = async (sessionId) => {
      const payload = await pageNotices(sessionId)
      return (payload.notices ?? []).map((notice) => notice.noticeId)
    }

    const firstPayload = await pageNotices(otherSession)
    const dwellMs = typeof firstPayload.seenDwellMs === 'number' ? firstPayload.seenDwellMs : 1500
    observations.dwellMs = dwellMs
    const negativeHoldMs = 3 * dwellMs + 1500
    /*
     * The positive hold is `dwell + 1200`, not `dwell + 2500`. Two short replies
     * fit in one band, so once the target is confirmed the client immediately
     * starts dwelling on the *next* offered notice that is still on screen; a
     * hold long enough for that second confirmation would spend the material the
     * following positive phase needs. 1200 ms is enough slack to see the first
     * confirmation (the client ticks every 300 ms) and too short for a second.
     */
    const positiveHoldMs = dwellMs + 1200
    log(`dwell ${dwellMs} ms; negative holds ${negativeHoldMs} ms, positive holds ${positiveHoldMs} ms`)

    /*
     * The material has to be unconfirmed *now*, not when it was picked. Setup
     * takes seconds and the second tab's own client is live throughout it, so a
     * notice observed in the meantime would silently become the wrong subject for
     * every phase below. Re-read and record before judging anything.
     */
    const recheck = await hostState()
    const stillOpen = material.map((notice) => {
      const now = (recheck?.notices ?? []).find((each) => each.noticeId === notice.noticeId) ?? null
      return { noticeId: notice.noticeId, turn: String(notice.targetTurnRef), state: now === null ? null : now.state }
    })
    const lost = stillOpen.filter((each) => each.state !== 'pending' && each.state !== 'shown')
    record('C0-material-still-open', lost.length === 0 ? 'PASS' : 'SKIP',
      lost.length === 0
        ? `${stillOpen.length} notice(s) still unconfirmed after setup: `
          + stillOpen.map((each) => `${each.turn}:${each.noticeId.slice(0, 8)}:${String(each.state)}`).join(', ')
        : `setup already settled ${lost.map((each) => `${each.turn}:${each.noticeId.slice(0, 8)}:${String(each.state)}`).join(', ')}`
          + ' — those are dropped and the phases run against what is still open')
    observations.notes.push(`material after setup: ${JSON.stringify(stillOpen)}`)
    if (lost.length > 0) {
      material = material.filter((notice) => !lost.some((each) => each.noticeId === notice.noticeId))
    }
    if (material.length < 1) {
      record('C0-material-usable', 'SKIP',
        'no unconfirmed notice survived setup, so neither the cross-session nor the positive phase has a subject')
      return 2
    }
    if (material.length < 3) {
      observations.notes.push(`only ${material.length} unconfirmed notice(s) left after setup;`
        + ' the multi-notice, mismatch and post-dismissal phases need three and will be recorded as skipped')
    }

    /**
     * One phase: baseline, prepare, hold, harvest.
     *
     * `prepare` does the tab work (which tab is in front, focus emulation, where
     * the conversation is scrolled) and returns the geometry it achieved; the
     * hold then just waits, because re-scrolling during a hold is exactly how the
     * Gate A counterexample gets quietly destroyed.
     */
    const runPhase = async (phase) => {
      const noticeId = phase.notice.noticeId
      const seenBefore = (await pageSeen(noticeId)).length
      const hostBefore = await hostNotice(noticeId)
      /*
       * Time the staging as well as the hold. The hold alone understates the
       * continuous visible time the client saw: it accrues dwell while the reply
       * is being scrolled into the band, so a phase can be confirmed 326 ms into
       * a 2700 ms hold with its dwell already satisfied. Both marks are recorded
       * so the verdict can say which claim the phase actually supports.
       */
      const prepareStartedAt = Date.now()
      const prepared = await phase.prepare()
      /*
       * Hold, with an early exit for the phases that must confirm something.
       *
       * Two short replies fit in one band, so a fixed hold long enough to be safe
       * is also long enough for the client to move on to the *next* notice and
       * confirm that one too — which is how the third live run starved the
       * following phase of its subject. A positive phase therefore stops as soon
       * as its own notice reaches `seen`; the negative phases hold for the whole
       * window, because "nothing happened" is only meaningful over time.
       */
      const holdStartedAt = Date.now()
      const deadline = holdStartedAt + phase.holdMs
      let settledEarly = false
      while (Date.now() < deadline) {
        await sleep(Math.min(300, Math.max(0, deadline - Date.now())))
        if (phase.settleOnConfirm !== true) continue
        if ((await hostNotice(noticeId)).state === 'seen') {
          settledEarly = true
          break
        }
      }
      const heldMs = Date.now() - holdStartedAt
      const prepareMs = holdStartedAt - prepareStartedAt
      const after = await pageState()
      const seenAfter = (await pageSeen(noticeId)).slice(seenBefore)
      const afterNotice = await hostNotice(noticeId)
      const offeredAfter = await offeredIds(otherSession)
      /*
       * Hand the front back to tab A. The second tab stays focused between
       * phases otherwise, and every extra second it spends on screen is another
       * dwell it can spend on a notice a later phase still needs.
       */
      if (phase.restoreFront !== false) {
        try { await cdp.send('Page.bringToFront') } catch { /* the tab is gone; the next phase closes on it anyway */ }
      }
      const stillOffered = offeredAfter.includes(noticeId)
      const otherSessionOffer = await offeredIds(expectedSession)
      const entry = {
        id: phase.id,
        title: phase.title,
        kind: phase.kind,
        holdMs: phase.holdMs,
        heldMs,
        settledEarly,
        /*
         * Wall-clock marks around the confirmation. `seenAfterHoldStartMs` is how
         * far into the timed window the host recorded the observation;
         * `seenUpperBoundMs` is the most continuous visible-and-focused time the
         * phase could account for, measured from the moment staging began (an
         * upper bound, because the reply is not on screen for all of it).
         */
        timeline: {
          prepareStartedAt: new Date(prepareStartedAt).toISOString(),
          holdStartedAt: new Date(holdStartedAt).toISOString(),
          prepareMs,
          seenAt: afterNotice.seenAt === null || afterNotice.seenAt === undefined
            ? null
            : new Date(afterNotice.seenAt).toISOString(),
          seenAfterHoldStartMs: afterNotice.seenAt === null || afterNotice.seenAt === undefined
            ? null
            : afterNotice.seenAt - holdStartedAt,
          seenUpperBoundMs: afterNotice.seenAt === null || afterNotice.seenAt === undefined
            ? null
            : afterNotice.seenAt - prepareStartedAt,
        },
        target: {
          noticeId,
          runId: phase.notice.runId ?? null,
          sessionId: phase.notice.sessionId ?? null,
          targetTurnRef: String(phase.notice.targetTurnRef ?? ''),
        },
        expect: phase.expect ?? {},
        measured: {
          pageVisible: after.visible,
          pageFocused: after.focused,
          replyOnBand: prepared.geometry.replyOnBand,
          replyOffBand: prepared.geometry.replyOffBand,
          otherTurnOnBand: prepared.geometry.otherTurnOnBand ?? null,
          groupOverlap: prepared.geometry.groupOverlap,
          groupTop: prepared.geometry.groupTop ?? null,
          bandTop: prepared.geometry.bandTop ?? null,
          ownsBandTop: prepared.geometry.ownsBandTop ?? null,
          watchPredictedNoticeId: prepared.geometry.watchPredictedNoticeId ?? null,
          watchPredictedTurn: prepared.geometry.watchPredictedTurn ?? null,
          watchPredictedVisible: prepared.geometry.watchPredictedVisible ?? null,
          watchOrder: prepared.geometry.watchOrder ?? null,
          watchNote: prepared.geometry.watchNote ?? null,
          scrollTopAfter: after.scrollTop,
        },
        seenBefore,
        seenAfter,
        hostBefore,
        hostAfter: {
          state: afterNotice.state,
          seenAt: afterNotice.seenAt,
          offered: stillOffered,
          rebuilt: phase.kind === 'dismissed' ? null : undefined,
        },
        scoping: { otherSessionOfferNoticeIds: otherSessionOffer },
        /*
         * Read back *after* the hold, not before it: the whole point of the
         * witness is where the other notices ended up once the confirmation had a
         * chance to go wrong, and a state captured before the dwell would report
         * "still offered" no matter what happened during it.
         */
        alsoUnchanged: (phase.alsoUnchanged ?? []).map((other) => ({
          noticeId: other.noticeId,
          offered: offeredAfter.includes(other.noticeId),
        })),
        notes: prepared.notes ?? [],
      }
      observations.phases.push(entry)
      log(`${entry.id}: held ${entry.heldMs}/${entry.holdMs} ms${entry.settledEarly ? ' (settled on confirmation)' : ''}`
        + (entry.timeline.seenAfterHoldStartMs === null ? '' : `, confirmed +${entry.timeline.seenAfterHoldStartMs} ms`)
        + ` — new /seen=${entry.seenAfter.length},`
        + ` host "${String(entry.hostBefore.state)}" -> "${String(entry.hostAfter.state)}", offered=${String(entry.hostAfter.offered)},`
        + ` visibility "${String(entry.measured.pageVisible)}" focused=${String(entry.measured.pageFocused)},`
        + ` reply overlap=${String(entry.measured.groupOverlap)}`)
      return entry
    }

    /* --------------------------------------------------------- the phases */

    /*
     * Subjects come out of the *live* offer, oldest first, because every phase
     * retires material: the client confirms one notice per dwell, so a phase that
     * assumed a fixed role for `material[1]` would end up judging whatever was
     * left over. `openMaterial()` re-reads the host before each phase, so the
     * roles are always taken from what is actually still unconfirmed.
     */
    const turnOfNotice = (notice) => {
      const turn = Number(notice?.targetTurnRef)
      return Number.isSafeInteger(turn) ? turn : null
    }
    const openMaterial = async () => {
      const state = await hostState()
      return (state?.notices ?? [])
        .filter((notice) => notice.sessionId === otherSession)
        .filter((notice) => notice.state === 'pending' || notice.state === 'shown')
        .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0))
    }
    /** Describe what the page is looking at, for `measured` and the judge. */
    const geometryOf = async (snapshot, watch, extra = {}) => ({
      replyOnBand: snapshot !== null && snapshot.groupOverlap !== null && snapshot.groupOverlap > 0,
      replyOffBand: snapshot !== null && snapshot.groupOverlap !== null && snapshot.groupOverlap < 0,
      groupOverlap: snapshot === null ? null : snapshot.groupOverlap,
      groupTop: snapshot === null ? null : snapshot.groupTop,
      bandTop: snapshot === null ? null : snapshot.bandTop,
      ownsBandTop: snapshot !== null && snapshot.groupTop !== null && snapshot.groupTop <= snapshot.bandTop + 24,
      watchPredictedNoticeId: watch?.predicted?.noticeId ?? null,
      watchPredictedTurn: watch?.predicted?.turn ?? null,
      watchPredictedVisible: watch?.predicted?.visible ?? null,
      watchOrder: watch?.order ?? null,
      watchNote: extra.watchNote ?? null,
      ...extra,
    })
    /**
     * Which turns the conversation can actually render.
     *
     * `[data-chat-turn]` is virtualised, and a live run found that session B's
     * *oldest* unconfirmed notice points at a turn the container refuses to
     * render at all — `revealTurn` jumps to the top, walks, and still finds
     * nothing. That is not a product failure and it is not a reason to abandon
     * the run: a notice whose result no page can render simply cannot be
     * confirmed, which makes it the perfect off-screen witness for the mismatch
     * and multi-notice phases. Probing is cached per turn, because the answer
     * cannot change and each failed walk costs a second of a focused tab.
     */
    const renderable = new Map()
    const canRender = async (turn) => {
      if (renderable.has(turn)) return renderable.get(turn)
      if ((await pageSnapshot(turn)).rendered === true) {
        renderable.set(turn, true)
        return true
      }
      const revealed = await revealTurn(turn)
      log(`  reveal turn ${turn} -> found=${String(revealed.found)} steps=${String(revealed.steps)} ${String(revealed.strategy ?? revealed.reason)}`)
      renderable.set(turn, revealed.found === true)
      return revealed.found === true
    }
    /** The notices whose turn renders, oldest first. */
    const revealable = async (notices) => {
      const out = []
      for (const notice of notices) {
        const turn = turnOfNotice(notice)
        if (turn === null) continue
        if (await canRender(turn)) out.push(notice)
        else log(`  turn ${turn} has no renderable result; it can only ever be an off-screen witness`)
      }
      return out
    }

    const rendered = await revealable(material)
    const targetNotice = rendered[0] ?? null
    if (targetNotice === null) {
      record('C0-target-rendered', 'SKIP',
        `none of the ${material.length} unconfirmed notice(s) in ${String(otherSession)} has a result the page can render,`
        + ' so there is nothing to observe at all')
      return 2
    }
    const targetTurn = turnOfNotice(targetNotice)
    observations.target = {
      noticeId: targetNotice.noticeId,
      runId: targetNotice.runId ?? null,
      sessionId: targetNotice.sessionId ?? null,
      targetTurnRef: String(targetNotice.targetTurnRef),
    }
    observations.notes.push(`renderable subjects: ${JSON.stringify(rendered.map((notice) => String(notice.targetTurnRef)))},`
      + ` unrenderable: ${JSON.stringify(material.filter((notice) => !rendered.includes(notice)).map((notice) => String(notice.targetTurnRef)))}`)

    /*
     * 1. the user is on A: B's reply is on B's screen and B is not even visible.
     *
     * The subject is the **oldest** unconfirmed notice, parked at the band top.
     * That makes it the oldest candidate in the offer *and* the one on screen, so
     * the page's own rule can only pick it — the strongest form of the claim, and
     * the only choice that a second tab's scenery cannot invalidate. The mirror is
     * read back after the park and recorded, so a phase that ended up watching
     * something else is reported as unproven rather than as a product failure.
     */
    await runPhase({
      id: 'C1-other-session',
      title: 'the focused tab is on session A while B\'s reply sits on B\'s screen',
      kind: 'negative',
      notice: targetNotice,
      holdMs: negativeHoldMs,
      expect: { visible: 'hidden', focused: false, replyOnBand: true, watched: true },
      prepare: async () => {
        await cdp.send('Page.bringToFront')
        /* Focus emulation off, so the hidden tab reports its own focus rather than a forced one. */
        await setFocusEmulation(false)
        await sleep(800)
        const parked = await parkAtBandTop(targetTurn)
        const snapshot = await pageSnapshot(targetTurn)
        const watch = await pageWatch(otherSession)
        const offerA = await pageNotices(expectedSession)
        return {
          geometry: await geometryOf(snapshot, watch, { otherTurnOnBand: null }),
          notes: [`tab A brought to front; A is offered ${offerA.notices.length} notice(s)`,
            `parkAtBandTop(${targetTurn}) staged=${String(parked.staged)} clamped=${String(parked.clamped)}`,
            `the page would watch ${String(watch?.predicted?.noticeId ?? 'nothing')} (the notice this phase judges)`],
        }
      },
    })

    /* 2. visible but blurred — opt-in, see GATE_C_BLUR */
    if (GATE_C_BLUR) {
      await runPhase({
        id: 'C2-blurred-window',
        title: 'the window is not focused although the reply is on screen',
        kind: 'negative',
        notice: targetNotice,
        holdMs: negativeHoldMs,
        expect: { visible: 'visible', focused: false, watched: true },
        prepare: async () => {
          await cdpB.send('Page.bringToFront')
          await setFocusEmulation(false)
          await sleep(800)
          const parked = await parkAtBandTop(targetTurn)
          const snapshot = await pageSnapshot(targetTurn)
          const reported = await pageState()
          return {
            geometry: {
              replyOnBand: snapshot.groupOverlap !== null && snapshot.groupOverlap > 0,
              replyOffBand: snapshot.groupOverlap !== null && snapshot.groupOverlap < 0,
              groupOverlap: snapshot.groupOverlap,
            },
            notes: [`focus emulation off; page reports visibility "${reported.visible}" focused=${reported.focused}`,
              `parkAtBandTop staged=${String(parked.staged)}`],
          }
        },
      })
    } else {
      record('C2-blurred-window', 'SKIP',
        'not attempted: this machine cannot make the browser window lose focus, a focused page would legitimately'
        + ' confirm the notice this phase needs, and "blurred or background" is covered by C1 (background).'
        + ' Pass --gate-c-blur to attempt it anyway with material to spare.')
    }

    /**
     * The positive half: bring B to the front, let the notice the page actually
     * watches reach its dwell, and read the host back.
     *
     * `parkAtBandTop` rather than `parkInBand`, because the client watches the
     * *oldest visible* candidate: a sliver of an older reply left on screen would
     * move the confirmation onto that older notice, and the check would then be
     * about a notice this phase never targeted. The mirror (`watchMirror`) is read
     * back after the park and recorded, so the judge can tell "the page was
     * watching this notice and confirmed it" from "the page was watching
     * something else" — the second case is exactly what the first live Gate C run
     * reported as a product FAIL.
     */
    const positive = async (notice, alsoUnchanged, id, title) => {
      const turn = turnOfNotice(notice)
      if (turn === null) {
        record(id, 'SKIP', `notice ${String(notice.noticeId)} carries no usable turn`)
        return
      }
      await runPhase({
        id,
        title,
        kind: 'positive',
        notice,
        alsoUnchanged,
        holdMs: positiveHoldMs,
        settleOnConfirm: true,
        expect: { visible: 'visible', focused: true, replyOnBand: true },
        prepare: async () => {
          await setFocusEmulation(true)
          await cdpB.send('Page.bringToFront')
          await sleep(600)
          await nudgeFocus()
          const revealed = await revealTurn(turn)
          const parked = await parkAtBandTop(turn)
          const snapshot = await pageSnapshot(turn)
          const watch = await pageWatch(otherSession)
          return {
            geometry: await geometryOf(snapshot, watch, { otherTurnOnBand: null }),
            notes: [`revealTurn(${turn}) found=${String(revealed.found)} steps=${Number(revealed.steps)}`
              + ` strategy=${String(revealed.strategy ?? revealed.reason)}`,
              `parkAtBandTop staged=${String(parked.staged)} clamped=${String(parked.clamped)}, scrollTop ${String(parked.applied)}`,
              `the page would watch ${String(watch?.predicted?.noticeId ?? 'nothing')}`],
          }
        },
      })
    }

    /*
     * 3. an older, off-screen notice must not block the newer one that is on screen.
     *
     * The witness is the **oldest** open notice whatever its renderability: an
     * unrenderable turn is exactly the notice a page can never vouch for, which is
     * the "older result off screen" half of the claim. The subject is the oldest
     * *renderable* open notice that is not the witness, parked at the band top so
     * the witness cannot come back on screen.
     */
    const multiOpen = await openMaterial()
    const multiRevealable = await revealable(multiOpen)
    const witness = multiOpen[0] ?? null
    const onScreen = multiRevealable.find((notice) => notice.noticeId !== witness?.noticeId) ?? null
    if (witness === null || onScreen === null) {
      record('C4-multi-notice', 'SKIP',
        `session B offered ${multiOpen.length} unconfirmed notice(s), of which ${multiRevealable.length} has a renderable`
        + ' result; the multi-notice phase needs an off-screen witness and a different notice on screen')
    } else {
      await positive(onScreen, [{ noticeId: witness.noticeId }], 'C4-multi-notice',
        `turn ${String(turnOfNotice(onScreen))}'s reply owns the band while the older notice`
        + ` ${String(witness.noticeId).slice(0, 8)} (turn ${String(turnOfNotice(witness))}) stays off screen and unconfirmed`)
    }

    /* 4. switch to B and actually read the oldest unconfirmed notice's result */
    const finalOpen = await openMaterial()
    const finalRevealable = await revealable(finalOpen)
    const finalNotice = finalRevealable[0] ?? null
    if (finalNotice === null) {
      record('C5-switch-to-B', 'SKIP',
        `session B offered ${finalOpen.length} unconfirmed notice(s) and none of them has a renderable result left to read`)
    } else {
      await positive(finalNotice, [], 'C5-switch-to-B',
        `switch to B and read turn ${String(turnOfNotice(finalNotice))}'s result`)
    }

    /*
     * 5. the user closed a popup: looking at its result again must change nothing.
     *
     * The newest *renderable* unconfirmed notice is closed, and this runs **after**
     * the two positive phases: whatever it parks on screen, the second tab is
     * focused and everything still unconfirmed and visible would be confirmed
     * during a 6000 ms hold. With the positives done, the only notice left open is
     * normally the off-screen witness, so the hold is inert. Closing happens after
     * the turn is revealed — the first live run closed first and lost the material
     * when the turn turned out not to be renderable.
     */
    const dismissOpen = await openMaterial()
    const dismissable = await revealable(dismissOpen)
    const closed = dismissable.length > 0 ? dismissable[dismissable.length - 1] : null
    const closedTurn = closed === null ? null : turnOfNotice(closed)
    if (closed === null || closedTurn === null) {
      record('C6-dismissed-then-reviewed', 'SKIP', 'session B offered no renderable unconfirmed notice left to close')
    } else {
      const acked = await hostAck(closed.noticeId, 'dismissed')
      log(`/ack dismissed ${String(closed.noticeId).slice(0, 8)} -> {"status":${String(acked.status)},"ok":${String(acked.ok)},"state":${JSON.stringify(acked.state)}}`)
      if (acked.ok !== true || acked.state !== 'dismissed') {
        record('C6-dismissed-then-reviewed', 'SKIP',
          `the pet's manual close was not accepted (HTTP ${String(acked.status)}, state ${String(acked.state)}),`
          + ' so the post-dismissal state was never reached')
      } else {
        await runPhase({
          id: 'C6-dismissed-then-reviewed',
          title: `the user closed ${String(closed.noticeId).slice(0, 8)} and then looked at its result again`,
          kind: 'dismissed',
          notice: closed,
          holdMs: negativeHoldMs,
          expect: { visible: 'visible', focused: true, replyOnBand: true },
          prepare: async () => {
            await setFocusEmulation(true)
            await cdpB.send('Page.bringToFront')
            await sleep(600)
            await nudgeFocus()
            const parked = await parkAtBandTop(closedTurn)
            const snapshot = await pageSnapshot(closedTurn)
            const watch = await pageWatch(otherSession)
            return {
              geometry: await geometryOf(snapshot, watch, { otherTurnOnBand: null }),
              notes: [`parkAtBandTop(${closedTurn}) staged=${String(parked.staged)} clamped=${String(parked.clamped)}`,
                /*
                 * The mirror is read *after* the close, so the dismissed notice is
                 * no longer in the offer and this only says what the page moved on
                 * to. The judge's `dismissed` rules are about the host state and a
                 * second popup, not about the watch target.
                 */
                `after the close the page would watch ${String(watch?.predicted?.noticeId ?? 'nothing')}`],
            }
          },
        })
      }
    }

    /*
     * 6. the notice's turn is not the turn on screen: a mismatch must confirm nothing.
     *
     * Last, because its scenery can be any turn at all: by now the earlier
     * phases have confirmed the renderable subjects, so the judged notice is
     * normally the one the page cannot even render — the honest form of "the
     * result this notice points at is not the one being read".
     */
    const mismatchOpen = await openMaterial()
    const mismatchNotice = mismatchOpen[0] ?? null
    const scenery = (await revealable(mismatchOpen)).find((notice) => notice.noticeId !== mismatchNotice?.noticeId)
      ?? (await revealable(material)).find((notice) => notice.noticeId !== mismatchNotice?.noticeId)
      ?? null
    if (mismatchNotice === null || scenery === null) {
      record('C3-turn-mismatch', 'SKIP',
        `session B offered ${mismatchOpen.length} unconfirmed notice(s) and no renderable turn was left to put on screen,`
        + ' so the mismatch could not be built')
    } else {
      const mismatchTurn = turnOfNotice(mismatchNotice)
      const sceneryTurn = turnOfNotice(scenery)
      await runPhase({
        id: 'C3-turn-mismatch',
        title: `turn ${String(sceneryTurn)}'s reply is on screen while ${String(mismatchNotice.noticeId).slice(0, 8)}`
          + ` points at turn ${String(mismatchTurn)}`,
        kind: 'negative',
        notice: mismatchNotice,
        holdMs: negativeHoldMs,
        expect: { visible: 'visible', focused: true, replyOffBand: true, replyOnBand: false, otherTurnOnBand: true, watched: false },
        prepare: async () => {
          await setFocusEmulation(true)
          await cdpB.send('Page.bringToFront')
          await sleep(600)
          await nudgeFocus()
          const revealed = await revealTurn(sceneryTurn)
          const parked = await parkAtBandTop(sceneryTurn)
          const onScreen = await pageSnapshot(sceneryTurn)
          const mine = await pageSnapshot(mismatchTurn)
          const watch = await pageWatch(otherSession)
          /*
           * A turn that is not rendered at all has no result box and therefore
           * cannot be visible, which is what this phase is about: once the band
           * shows a later turn, an earlier one is virtualised away, and calling
           * that "not measured" would throw away a good mismatch observation.
           */
          const notRendered = mine.rendered !== true
          return {
            geometry: await geometryOf(mine, watch, {
              replyOffBand: notRendered || (mine.groupOverlap !== null && mine.groupOverlap < 0),
              otherTurnOnBand: onScreen.groupOverlap !== null && onScreen.groupOverlap > 0,
            }),
            notes: [`turn ${String(sceneryTurn)} parked at the band top (staged=${String(parked.staged)},`
              + ` found=${String(revealed.found)}), the judged notice points at turn ${String(mismatchTurn)}`
              + ` rendered=${String(mine.rendered)} overlap=${String(mine.groupOverlap)}`,
              `the page would watch ${String(watch?.predicted?.noticeId ?? 'nothing')}`],
          }
        },
      })
    }

    /* ------------------------------------------------------------ verdicts */

    const judged = await asJson(`JSON.stringify(window.__petGateCJudge.judge(${JSON.stringify(observations)}))`)
    for (const check of judged) record(check.id, check.verdict, check.detail)

    const failed = checks.filter((check) => check.verdict === 'FAIL')
    const unproven = checks.filter((check) => check.verdict === 'SKIP' || check.verdict === 'INCONCLUSIVE')
    const verdict = failed.length > 0 ? 'FAIL' : (unproven.length > 0 ? 'INCOMPLETE' : 'PASS')
    const report = {
      verdict,
      mode: 'gate-c',
      runnerVersion: pageVersion,
      judgeVersion,
      startedAt,
      finishedAt: new Date().toISOString(),
      pageUrl: PAGE_URL,
      debugPort: port,
      sessionId: expectedSession,
      otherSession,
      tabIds: { a: tabAId ?? null, b: tabBId ?? null },
      target: observations.target,
      checks,
      observations,
      console: consoleLines,
    }
    const wrote = writeReport(report)
    log('================ SUMMARY ================')
    for (const check of checks) log(`${String(check.verdict).padEnd(13)} ${check.id}`)
    log(`VERDICT: ${verdict}${failed.length > 0 ? ` -> ${failed.map((check) => check.id).join(', ')}` : ''}`)
    log(`unproven: ${unproven.length}`)
    if (!wrote) return 3
    log(`report written to ${OUT_PATH}`)
    return failed.length > 0 ? 1 : (unproven.length > 0 ? 2 : 0)
  } catch (error) {
    const report = {
      verdict: 'DRIVER-ERROR',
      mode: 'gate-c',
      startedAt,
      finishedAt: new Date().toISOString(),
      pageUrl: PAGE_URL,
      error: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : ''),
      checks,
      observations,
      console: consoleLines,
    }
    let wrote = false
    try {
      wrote = writeReport(report)
    } catch {
      // Nothing more we can do.
    }
    log(`DRIVER-ERROR: ${report.error}`)
    log(wrote ? `report written to ${OUT_PATH}` : `report NOT written to ${OUT_PATH}`)
    return 3
  } finally {
    try { cdpB?.close() } catch { /* already gone */ }
  }
}

/* -------------------------------------------------------------- orchestration */


async function main() {
  const startedAt = new Date().toISOString()
  const runnerSource = readFileSync(RUNNER_PATH, 'utf8')
  const runnerVersion = /RUNNER_VERSION = '([^']+)'/.exec(runnerSource)?.[1] ?? 'unknown'
  log(`runner ${runnerVersion} (${RUNNER_PATH})`)

  let browser = null
  try {
    browser = await launchBrowser(FORCE_NO_SANDBOX ? ['--no-sandbox'] : [])
  } catch (error) {
    if (FORCE_NO_SANDBOX) throw error
    log(`launch failed (${String(error.message)}); retrying with --no-sandbox`)
    browser = await launchBrowser(['--no-sandbox'])
  }

  const consoleLines = []
  /** Evidence captured when the page does not reach the ready gate; goes in the error report. */
  let diagnostics = null
  let cdp = null
  try {
    const target = await findPageTarget(browser.port)
    log(`driving target ${target.id} -> ${target.url} (port ${browser.port})`)

    cdp = await withTimeout(connectCdp(target.webSocketDebuggerUrl), 15000, 'CDP connect')
    cdp.on((message) => {
      /*
       * Page exceptions are forwarded too: when the pet client or the harness
       * shell fails to boot, the poll below only ever sees "not ready", and the
       * reason would otherwise be invisible (this cost ROUND 4 one whole run).
       */
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails ?? {}
        const text = `[page exception] ${details.exception?.description ?? details.text ?? 'unknown'}`
        consoleLines.push(text)
        console.log(text)
        return
      }
      if (message.method !== 'Runtime.consoleAPICalled') return
      const text = (message.params.args ?? [])
        .map((arg) => (arg.value === undefined ? `<${arg.type}>` : String(arg.value)))
        .join(' ')
      consoleLines.push(text)
      console.log(text)
    })

    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // The harness page may set a CSP; the runner is injected as an expression.
    await cdp.send('Page.setBypassCSP', { enabled: true })

    /*
     * Authenticate before navigating: `/` answers 401 without the browser
     * session cookie, and a fresh profile has none.
     */
    const cookie = resolveCookie()
    if (cookie === null) {
      log('browser authentication skipped (--no-auth)')
    } else {
      const { name, value } = splitCookie(cookie)
      await cdp.send('Network.enable')
      await cdp.send('Network.setCookie', { url: PAGE_URL, name, value })
      log(`browser session cookie set for ${new URL(PAGE_URL).host} (${name}, ${COOKIE_DAYS} d)`)
    }

    log(`navigating to ${PAGE_URL}`)
    await cdp.send('Page.navigate', { url: PAGE_URL })

    // Wait for the harness app *and* the pet client bundle to be alive.
    let { ready, lastPoll } = await waitForPageReady(cdp, 90000)
    if (ready) log(`page ready: tabId=${lastPoll.tab} turns=${lastPoll.turns} readyState=${lastPoll.ready}`)

    if (!ready) {
      /*
       * ROUND 4 finding: a fresh profile does **not** land on the most recent
       * session. It lands on the new-conversation placeholder, so no
       * `[data-chat-flow]` is ever rendered and the notice this run is waiting
       * for would never have a target. The session list is the only way in — the
       * harness has no session deep link — so open the expected session the way
       * the UI does, then wait again.
       */
      const expectedTitle = flag('session-title', null) ?? await fetchSessionTitle(EXPECTED_SESSION)
      if (expectedTitle !== null) log(`host calls ${EXPECTED_SESSION} "${expectedTitle}"`)
      const opened = await openSessionById(cdp, EXPECTED_SESSION, expectedTitle)
      log(`session pick: ${JSON.stringify({
        matchedBy: opened.matchedBy,
        clicked: opened.clicked,
        fibersExposed: opened.fibersExposed,
        rows: opened.rows?.length ?? 0,
      })}`)
      log(`session rows: ${JSON.stringify(opened.rows)}`)
      diagnostics = {
        reason: 'no conversation after load',
        page: await describePage(cdp),
        rows: opened.rows,
        matchedBy: opened.matchedBy,
      }
      if (opened.clicked) {
        log(`opened session ${EXPECTED_SESSION} from the session list; waiting for it to render`)
        ;({ ready, lastPoll } = await waitForPageReady(cdp, 60000))
        if (ready) log(`page ready after opening the session: turns=${lastPoll.turns}`)
      } else {
        log(`no session row exposed ${EXPECTED_SESSION}; it may be behind a collapsed group`)
      }
    }

    if (!ready) {
      /*
       * Record what the page *was* instead of asserting what it should have
       * been. `diagnostics` also lands in the report, so the failure is
       * reproducible from `tools/cdp-report.json` alone.
       */
      diagnostics = {
        ...(diagnostics ?? {}),
        lastPoll,
        page: await describePage(cdp),
        sessions: await describeSessions(cdp),
      }
      log(`page never became ready; last poll: ${JSON.stringify(lastPoll)}`)
      log(`page dump: ${JSON.stringify(diagnostics.page)}`)
      log(`session candidates: ${diagnostics.sessions}`)
      throw new Error(
        'the page never rendered a conversation flow with a live pet client'
        + ` (flow=${lastPoll?.flow} tabId=${lastPoll?.tab ?? null} turns=${lastPoll?.turns} readyState=${lastPoll?.ready})`,
      )
    }

    // Headless focus is unreliable, and L2 gates the whole ladder.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const focused = await evaluate(cdp, `JSON.stringify({ hasFocus: document.hasFocus(), visibility: document.visibilityState })`)
    log(`focus emulation on: ${focused}`)

    const ourTabId = await evaluate(cdp, `sessionStorage.getItem('dsh-pet-seen:tab-id')`)

    const clientSession = await probeSession(cdp)
    log(`the tab is on session ${String(clientSession)}`)
    if (clientSession === null) {
      throw new Error('the pet client in this page never identified a session; is the plugin loaded for this profile?')
    }
    if (EXPECTED_SESSION !== null && clientSession !== EXPECTED_SESSION) {
      // The harness has no session deep link, so the only honest move is to
      // stop with the data needed to teach the driver how to switch tabs.
      log(`session list as the page renders it: ${await describeSessions(cdp)}`)
      throw new Error(
        `the page is on ${clientSession} but ${EXPECTED_SESSION} was expected;`
        + ' refusing to wait for a notice that can never arrive for this tab',
      )
    }

    /*
     * Gate C leaves this single-tab path here: it needs a second tab on another
     * session and control over which of them is in front, both of which only the
     * driver can do. Everything above (authentication, the picker, the ready gate,
     * the session assertion) is shared, and everything below (the Gate A runner)
     * is deliberately not run, so one mode cannot quietly stand in for the other.
     */
    if (GATE_C) {
      return await runGateC({
        cdp,
        port: browser.port,
        consoleLines,
        startedAt,
        expectedSession: clientSession,
        cookie,
        tabAId: ourTabId,
      })
    }

    /*
     * Read-only reconnaissance leaves here: it needs the page, the session
     * assertion and the host snapshot, and none of the driving below.
     */
    if (MEASURE_ONLY) {
      return await runMeasureOnly({
        cdp,
        port: browser.port,
        consoleLines,
        startedAt,
        expectedSession: clientSession,
        ourTabId,
      })
    }

    // Tuning: headless needs no click grace, and the wait is the caller's call.
    await evaluate(cdp, `window.__petAcceptConfig = ${JSON.stringify({
      clickGraceMs: 500,
      waitForNoticeMs: WAIT_FOR_NOTICE_MS,
    })}`)

    log(`running the acceptance runner (waits up to ${Math.round(WAIT_FOR_NOTICE_MS / 1000)} s for a notice)`)
    // NOTE: the runner file is executed verbatim.
    await evaluate(cdp, runnerSource, { awaitPromise: true, timeoutMs: WAIT_FOR_NOTICE_MS + 180000 })

    const raw = await evaluate(cdp, `JSON.stringify(window.__petAccept ?? null)`)
    const handle = raw === null ? null : JSON.parse(raw)
    if (handle === null) throw new Error('the runner finished without publishing window.__petAccept')

    /* ------------------------------------------------ derived driver checks */

    const derived = []
    if (EXPECTED_SESSION !== null && handle.sessionId !== EXPECTED_SESSION) {
      derived.push({
        id: 'DRIVER-session-matches',
        verdict: 'FAIL',
        detail: `page is on ${handle.sessionId}, expected ${EXPECTED_SESSION}`,
      })
    } else if (EXPECTED_SESSION !== null) {
      derived.push({ id: 'DRIVER-session-matches', verdict: 'PASS', detail: `session ${handle.sessionId}` })
    }

    const seenBodies = (handle.requests ?? [])
      .filter((entry) => entry.url.indexOf('/pet-bridge/seen') !== -1 && typeof entry.body === 'string')
      .map((entry) => {
        try { return JSON.parse(entry.body) } catch { return null }
      })
      .filter((body) => body !== null)
    const foreign = seenBodies.filter((body) => body.tabId !== ourTabId)
    derived.push({
      id: 'DRIVER-seen-from-this-tab',
      verdict: seenBodies.length === 0 ? 'SKIP' : (foreign.length === 0 ? 'PASS' : 'FAIL'),
      detail: seenBodies.length === 0
        ? 'no /seen was sent'
        : `${seenBodies.length} /seen report(s) for notice(s)`
          + ` ${[...new Set(seenBodies.map((body) => String(body.noticeId)))].join(', ')},`
          + ` ${foreign.length} from another tab (this tab is ${ourTabId})`,
    })

    /*
     * The run's own quadruple, carried into the report so the evidence can be tied
     * back to a single notice without reading the console log. The page asserts
     * that the notice's own `targetTurnRef` is the turn it measured; this records
     * which notice that was, and whether the observations the tab actually sent
     * belong to it. A `/seen` for a *different* notice cannot support this gate,
     * however many of them there are.
     */
    const targetNotice = handle.target ?? null
    derived.push({
      id: 'DRIVER-target-quadruple',
      verdict: targetNotice === null ? 'SKIP' : 'PASS',
      detail: targetNotice === null
        ? 'the runner published no target notice (it stopped before choosing one)'
        : `noticeId=${String(targetNotice.noticeId)} runId=${String(targetNotice.runId)}`
          + ` sessionId=${String(targetNotice.sessionId)} targetTurnRef=${String(targetNotice.targetTurnRef)}`,
    })
    const forTarget = targetNotice === null
      ? []
      : seenBodies.filter((body) => body.noticeId === targetNotice.noticeId)
    /*
     * Only a gate that actually reached its verdict can be unsupported. ROUND 7's
     * second live run proved why that distinction is needed: A2 skipped (the turn
     * had no head row to leave on screen), A3 skipped with it, and the tab's only
     * `/seen` named an older notice that was still on offer — correct client
     * behaviour, and nothing to do with this gate. Reporting that as FAIL turned
     * "the scenario could not be built" into "the product failed", which is the
     * misattribution the plan forbids.
     */
    const a3Verdict = (handle.checks ?? []).find((check) => check.id === 'A3-gate-a')?.verdict
    const gateReachedAVerdict = a3Verdict === 'PASS' || a3Verdict === 'FAIL'
    const seenAttribution = targetNotice === null || seenBodies.length === 0
      ? 'SKIP'
      : (forTarget.length > 0 ? 'PASS' : (gateReachedAVerdict ? 'FAIL' : 'SKIP'))
    derived.push({
      id: 'DRIVER-seen-belongs-to-target',
      verdict: seenAttribution,
      detail: targetNotice === null
        ? 'no target notice to attribute the reports to'
        : seenBodies.length === 0
          ? `no /seen was sent, so nothing is attributed to ${String(targetNotice.noticeId)}`
          : forTarget.length > 0
            ? `${forTarget.length} of ${seenBodies.length} report(s) name the target notice ${String(targetNotice.noticeId)}`
            : `none of the ${seenBodies.length} report(s) name the target notice ${String(targetNotice.noticeId)};`
              + (gateReachedAVerdict
                ? ` Gate A concluded ${String(a3Verdict)}, so its verdict rests on a report this tab never made`
                : ' Gate A never reached a verdict, so no conclusion was drawn from them'),
    })

    /* ------------------------------------------------------------- report */

    const checks = [...(handle.checks ?? []), ...derived]
    const failed = checks.filter((check) => check.verdict === 'FAIL')
    const unproven = checks.filter((check) => check.verdict === 'SKIP' || check.verdict === 'INCONCLUSIVE')
    const unavailable = checks.filter((check) => check.verdict === 'INFO')
    const verdict = failed.length > 0 ? 'FAIL' : (unproven.length > 0 ? 'INCOMPLETE' : 'PASS')

    const report = {
      verdict,
      runnerVersion,
      startedAt,
      finishedAt: new Date().toISOString(),
      pageUrl: PAGE_URL,
      debugPort: browser.port,
      sessionId: handle.sessionId ?? null,
      ourTabId,
      /** noticeId / runId / sessionId / targetTurnRef of the notice the gates were judged against. */
      target: targetNotice,
      checks,
      seenReports: seenBodies,
      console: consoleLines,
    }
    const wrote = writeReport(report)

    log('================ SUMMARY ================')
    for (const check of checks) log(`${String(check.verdict).padEnd(13)} ${check.id}`)
    log(`VERDICT: ${verdict}${failed.length > 0 ? ` -> ${failed.map((check) => check.id).join(', ')}` : ''}`)
    log(`unproven: ${unproven.length}, informational: ${unavailable.length}`)
    if (!wrote) return 3
    log(`report written to ${OUT_PATH}`)

    return failed.length > 0 ? 1 : (unproven.length > 0 ? 2 : 0)
  } catch (error) {
    // A driver failure must be recorded, not swallowed: "did not run" and
    // "ran and passed" are different results.
    const report = {
      verdict: 'DRIVER-ERROR',
      runnerVersion,
      startedAt,
      finishedAt: new Date().toISOString(),
      pageUrl: PAGE_URL,
      error: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : ''),
      diagnostics,
      console: consoleLines,
    }
    let wrote = false
    try {
      wrote = writeReport(report)
    } catch {
      // Nothing more we can do.
    }
    log(`DRIVER-ERROR: ${report.error}`)
    log(wrote ? `report written to ${OUT_PATH}` : `report NOT written to ${OUT_PATH}`)
    return 3
  } finally {
    cdp?.close()
    if (browser !== null && !KEEP_OPEN) {
      // Kill the whole tree and drop the temporary profile: a browser left
      // behind would keep holding a directory under %TEMP% and could confuse the
      // next run's ownership check.
      killBrowser(browser.pid, browser.profile)
      log(`browser pid ${browser.pid} killed, temporary profile removed`)
    } else if (browser !== null) {
      log(`browser pid ${browser.pid} left running (--keep-open), profile ${browser.profile}`)
    }
  }
}

process.exitCode = await main()
