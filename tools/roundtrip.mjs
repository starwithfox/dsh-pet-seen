/**
 * Offline protocol round trip, driven through the real transports.
 *
 * This script proves the four participants agree on the wire format without a
 * running DSH and without the Python pet:
 *
 *   1. fake DSH events -> plugin state machine
 *   2. plugin -> POST /event -> pet listener              (completed, seen:false)
 *   3. pet    -> POST /ack   -> plugin                    (popup now "shown")
 *   4. browser -> POST /pet-bridge/visibility             (focus lease)
 *   5. browser -> GET  /pet-bridge/notices                (what to watch)
 *   6. browser -> POST /pet-bridge/seen                   (L3 observation)
 *   7. plugin -> POST /event -> pet listener              (notice/seen cancels it)
 *
 * Step 4-7 run against a fake DSH WebServer, which is the only way to exercise
 * the browser routes without starting a real host. The same-origin gate and the
 * focus-lease check are asserted here rather than assumed.
 *
 * It publishes its handshake file to a private temp path, so it is safe to run
 * while a real bridge is serving DSH. (It used to write the shared
 * `~/.dsh/pet-bridge.json`: the port-0 test instance then overwrote the live
 * credentials and a running DSH answered 401 to its own pet.)
 *
 * Usage: node tools/roundtrip.mjs
 *
 * @module tools/roundtrip
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { apply, PROTOCOL_VERSION } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

/** Private credential path for this run; never the shared user path. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-pet-seen-roundtrip-'))

/** Everything the plugin pushes at the pet. */
const received = []

/* ---------------------------------------------------------------- fake pet */

const petServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/event' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  res.writeHead(404)
  res.end()
})
const petPort = await new Promise((resolve) => {
  petServer.listen(0, '127.0.0.1', () => resolve(petServer.address().port))
})

/* ------------------------------------------------- fake DSH WebServer (browser routes) */

/** Route table handed to the plugin through the injected `webServer` service. */
const routes = new Map()
const webServer = {
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => { routes.delete(route.path) }
  },
}
const browserServer = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  void handler(req, res)
})
const browserPort = await new Promise((resolve) => {
  browserServer.listen(0, '127.0.0.1', () => resolve(browserServer.address().port))
})

/* ------------------------------------------------------------ fake harness */

let emitStatus = () => {}
let emitEvent = () => {}
let controlPort = null
let controlToken = null
const disposers = []

const ctx = {
  on: (name, listener) => {
    if (name === 'agent/status') emitStatus = listener
    if (name === 'session/event') emitEvent = listener
    return () => true
  },
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  inject: (names, callback) => {
    if (!names.includes('webServer')) return
    callback({
      get: (name) => (name === 'webServer' ? webServer : undefined),
      effect: (cb) => {
        const disposer = cb()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
    })
    return () => {}
  },
  logger: { info: () => {}, warn: () => {} },
}

apply(ctx, {
  controlPort: 0,
  tokenFile: join(scratch, 'pet-bridge.json'),
  petPort,
  // Deliver immediately: this script is about the wire format, not the "did the
  // user see it first" race, which the test suite covers.
  notifyDelayMs: 0,
  petEventTimeoutMs: 1000,
  idleGraceMs: 200,
  seenDwellMs: 20,
  maxNotices: 50,
  noticeTtlMs: 3_600_000,
  includeTitle: true,
}, {
  onReady: (hooks) => {
    hooks.onControlBound((result) => {
      if (!result.ok) throw new Error(`control listener failed: ${result.reason}`)
      controlPort = result.port
      controlToken = result.token
    })
  },
})

/** Poll until `check` holds. */
async function waitFor(check, label, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}
await waitFor(() => controlPort !== null, 'the control listener')

/** POST to the plugin's control listener (the pet's side). */
async function control(path, body) {
  const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, token: controlToken }),
  })
  return { status: response.status, body: await response.json() }
}

/** Call a browser route with a browser-shaped request. */
async function browser(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${browserPort}${path}`, {
    ...options,
    headers: {
      // A real same-origin fetch from the DSH page sets both of these.
      host: `127.0.0.1:${browserPort}`,
      origin: `http://127.0.0.1:${browserPort}`,
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: response.status, body }
}

/* --------------------------------------------------------------- the script */

console.log(`mock pet        :${petPort}`)
console.log(`fake DSH web    :${browserPort}`)
console.log(`plugin control  :${controlPort}\n`)

const hello = await control('/hello', { v: PROTOCOL_VERSION, petVersion: 'roundtrip', port: petPort })
assert.equal(hello.status, 200, 'handshake accepted')
console.log('1. handshake                     ok')

const session = { id: 'roundtrip-session', header: { cwd: process.cwd(), title: 'roundtrip session' } }

/**
 * Run one root turn to completion through the fake harness.
 *
 * @param turn - turn number for the run.
 * @returns the `completed` event the pet received for it.
 */
async function runTurn(turn) {
  const before = received.filter(event => event.event === 'completed').length
  const now = Date.now()
  emitStatus({ agent: { session, status: 'running' }, status: 'running' })
  emitEvent(session, { type: 'turn/start', seq: turn * 10, time: now, data: { turn } })
  emitEvent(session, {
    type: 'tool/call',
    seq: turn * 10 + 1,
    time: now,
    data: { callId: `c${turn}`, name: 'grep', arguments: '{"pattern":"SECRET"}' },
  })
  emitEvent(session, {
    type: 'turn/end',
    seq: turn * 10 + 2,
    time: now,
    data: { turn, reason: { kind: 'completed' } },
  })
  emitStatus({ agent: { session, status: 'idle' }, status: 'idle' })
  await waitFor(
    () => received.filter(event => event.event === 'completed').length > before,
    `a completed event for turn ${turn}`,
  )
  return received.filter(event => event.event === 'completed').at(-1)
}

// Two runs, because the two notices exercise two different branches: one the
// pet has already shown (so an observation must retract it) and one still
// unconfirmed (so it is what the page is offered to watch).
const first = await runTurn(1)
assert.equal(first.targetTurnRef, '1')
assert.equal(first.seen, false)
assert.equal(first.runId !== undefined, true)
console.log(`2. completion pushed             ok   notice=${first.noticeId} turn=1 seen=false`)

const ack = await control('/ack', { noticeId: first.noticeId, action: 'shown' })
assert.equal(ack.status, 200)
assert.equal(ack.body.state, 'shown')
console.log('3. pet ack (shown)               ok')

const crossOrigin = await browser('/pet-bridge/visibility', {
  method: 'POST',
  headers: { origin: 'http://evil.example' },
  body: JSON.stringify({ v: 1, tabId: 'tab-1', sessionId: session.id, visible: true, focused: true }),
})
assert.equal(crossOrigin.status, 403, 'cross-origin call refused')
console.log('4. cross-origin refused          ok')

const visibility = await browser('/pet-bridge/visibility', {
  method: 'POST',
  body: JSON.stringify({
    v: PROTOCOL_VERSION,
    tabId: 'tab-1',
    sessionId: session.id,
    visible: true,
    focused: true,
    title: 'roundtrip session',
  }),
})
assert.equal(visibility.status, 200)
console.log('5. visibility lease reported     ok')

const second = await runTurn(2)
assert.equal(second.targetTurnRef, '2')
assert.equal(JSON.stringify(received).includes('SECRET'), false, 'tool arguments never crossed the wire')

const notices = await browser(`/pet-bridge/notices?sessionId=${encodeURIComponent(session.id)}`)
assert.equal(notices.status, 200)
assert.equal(notices.body.seenDwellMs, 20)
// Both open notices are offered, oldest first. `first` is already `shown` — the
// pet has a popup up for it — and it must still be listed, because watching it
// is the only way the popup can be retracted once the user reads the result.
assert.deepEqual(
  notices.body.notices.map(notice => notice.noticeId),
  [first.noticeId, second.noticeId],
)
assert.equal(notices.body.notices[0].targetTurnRef, '1', 'the shown notice is still offered to the page')
assert.equal(notices.body.notices[0].state, 'shown', 'and it is labelled as already displayed')
assert.equal(notices.body.notices[1].targetTurnRef, '2', 'the page gets a turn reference to match against')
assert.equal(notices.body.notices[1].state, 'pending', 'an undelivered notice is labelled pending')
console.log('6. open notice query             ok   (pending + shown)')

// A report without `observed: true` must be refused: being visible is not
// seeing, which is the entire point of the L3 gate.
const weak = await browser('/pet-bridge/seen', {
  method: 'POST',
  body: JSON.stringify({
    v: PROTOCOL_VERSION,
    noticeId: second.noticeId,
    runId: second.runId,
    sessionId: session.id,
    tabId: 'tab-1',
  }),
})
assert.equal(weak.status, 200)
assert.equal(weak.body.accepted, false)
assert.equal(weak.body.reason, 'observed-flag-missing')
console.log('7. L2-only report refused        ok')

// No lease for this tab: the host refuses rather than trusting the page.
const noLease = await browser('/pet-bridge/seen', {
  method: 'POST',
  body: JSON.stringify({
    v: PROTOCOL_VERSION,
    noticeId: second.noticeId,
    runId: second.runId,
    sessionId: session.id,
    tabId: 'unknown-tab',
    observed: true,
  }),
})
assert.equal(noLease.body.accepted, false)
assert.equal(noLease.body.reason, 'no-effective-lease')
console.log('8. lease-less report refused     ok')

// The user then actually looks at the result they were shown: an L3
// observation on the already-displayed popup must retract exactly that popup.
const seen = await browser('/pet-bridge/seen', {
  method: 'POST',
  body: JSON.stringify({
    v: PROTOCOL_VERSION,
    noticeId: first.noticeId,
    runId: first.runId,
    sessionId: session.id,
    tabId: 'tab-1',
    observed: true,
  }),
})
assert.equal(seen.status, 200)
assert.equal(seen.body.accepted, true, 'an L3 observation is accepted')

await waitFor(
  () => received.some(event => event.event === 'notice/seen' && event.noticeId === first.noticeId),
  'the notice/seen push',
)
const cancelled = received.find(event => event.event === 'notice/seen')
assert.equal(cancelled.noticeId, first.noticeId)
assert.equal(cancelled.runId, first.runId)
console.log('9. seen accepted -> pet cancels  ok')

// A second observation for a notice that is already seen is a no-op, not an
// error: two tabs may legitimately report the same result.
const repeat = await browser('/pet-bridge/seen', {
  method: 'POST',
  body: JSON.stringify({
    v: PROTOCOL_VERSION,
    noticeId: first.noticeId,
    runId: first.runId,
    sessionId: session.id,
    tabId: 'tab-1',
    observed: true,
  }),
})
assert.equal(repeat.body.accepted, true)
console.log('10. repeated observation is a no-op  ok')

// The `shown` notice is now `seen` and must have left the page-facing list,
// while the notice nothing has confirmed yet stays on offer.
const afterSeen = await browser(`/pet-bridge/notices?sessionId=${encodeURIComponent(session.id)}`)
assert.deepEqual(
  afterSeen.body.notices.map(notice => notice.noticeId),
  [second.noticeId],
  'a seen notice is withheld; an open one is not',
)
console.log('11. seen notice withheld          ok')

for (const dispose of disposers.splice(0)) await dispose()
petServer.closeAllConnections()
petServer.close()
browserServer.closeAllConnections()
browserServer.close()
rmSync(scratch, { recursive: true, force: true })
console.log('\nround trip complete: events -> notice -> popup -> ack -> L3 observation -> cancel')
