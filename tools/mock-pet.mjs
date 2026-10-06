#!/usr/bin/env node
/**
 * Mock desktop pet.
 *
 * A receiving end for the bridge, so the protocol can be exercised end to end
 * without any of the Python pet's UI. It implements the pet half of the
 * contract in `src/protocol.ts`:
 *
 * - listens on `127.0.0.1:<port>` (default 17322) for `POST /event`
 * - reads `~/.dsh/pet-bridge.json` for the control port and token
 * - handshakes with `POST /hello` and then aligns via `GET /state`
 * - dedupes events by `id` and keys its popups on `noticeId`
 * - accepts typed commands on stdin: `seen <noticeId>`, `dismiss <noticeId>`,
 *   `state`, `quit`
 *
 * Usage:
 *   node tools/mock-pet.mjs [--port 17322] [--no-handshake] [--quiet] [--ack-shown]
 *                           [--no-capabilities]
 *
 * `--no-capabilities` makes the handshake look like a pet that predates the
 * capability negotiation: same receiver, no `capabilities` field. That is the
 * legacy reading `PL-PR-NW-02` has to keep working, and it is the cheap way to
 * reproduce it by hand.
 *
 * `--ack-shown` makes the pet acknowledge every delivered completion as
 * `shown` straight away, the way a real pet does once it has put the popup on
 * screen. It exists because the `shown` state cannot be reached by hand: the
 * page observes a fresh notice within a couple of seconds, so a human typing
 * `seen <id>` always loses the race and the notice is retired before it is ever
 * displayed. Acceptance runs need the notice parked in `shown` — that is the
 * state D2 was about.
 *
 * @module tools/mock-pet
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const has = (name) => args.includes(`--${name}`)

const port = Number(flag('port', '17322'))
const quiet = has('quiet')
const autoHandshake = !has('no-handshake')
const autoAckShown = has('ack-shown')
const noCapabilities = has('no-capabilities')

/**
 * Capability names this receiver implements, mirroring `BRIDGE_CAPABILITIES` in
 * `src/protocol.ts` (PL-PR-NW-02).
 *
 * A literal on purpose: this file is a second implementation of the pet half, so
 * it must not import the plugin's source — `tests/negotiation.test.ts` compares
 * the two lists by value, and `--no-capabilities` runs the same receiver as the
 * legacy pet that declares nothing at all.
 */
const CAPABILITIES = ['events', 'state-sync', 'ack-shown', 'ack-dismissed', 'notice-seen']

/** Popups this pet believes are on screen, keyed by noticeId. */
const shown = new Map()
/** Event ids already applied, for dedupe. */
const seenEventIds = new Set()
let controlPort = null
let token = null

const log = (...parts) => { if (!quiet) console.log(...parts) }

/** Read the handshake file the plugin writes. */
function readBridgeFile() {
  const path = join(homedir(), '.dsh', 'pet-bridge.json')
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw.controlPort === 'number' && typeof raw.token === 'string') {
      controlPort = raw.controlPort
      token = raw.token
      return true
    }
  } catch {
    return false
  }
  return false
}

/** POST JSON to the plugin's control listener. */
async function control(path, body) {
  if (controlPort === null) {
    if (!readBridgeFile()) return null
  }
  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, token }),
    })
    return await response.json()
  } catch {
    return null
  }
}

/** GET the plugin's snapshot. */
async function readState() {
  if (controlPort === null && !readBridgeFile()) return null
  try {
    const response = await fetch(
      `http://127.0.0.1:${controlPort}/state?token=${encodeURIComponent(token ?? '')}`,
    )
    return await response.json()
  } catch {
    return null
  }
}

/** Render one pushed event. */
function handleEvent(event) {
  if (typeof event.id === 'string') {
    if (seenEventIds.has(event.id)) {
      log(`dup  ${event.id} ignored`)
      return
    }
    seenEventIds.add(event.id)
    if (seenEventIds.size > 500) {
      // Bounded dedupe table: drop the oldest id.
      const oldest = seenEventIds.values().next().value
      if (oldest !== undefined) seenEventIds.delete(oldest)
    }
  }
  const label = `[${event.event}] ${event.sessionId ?? '?'}`
  switch (event.event) {
    case 'completed': {
      // The whole point: `seen: true` means do not pop anything.
      if (event.seen === true) {
        log(`${label} completed (already seen, no popup) notice=${event.noticeId}`)
        return
      }
      shown.set(event.noticeId, event)
      log(`${label} completed -> SHOW POPUP notice=${event.noticeId} turn=${event.targetTurnRef} ${event.title ?? ''}`)
      if (autoAckShown && typeof event.noticeId === 'string') {
        // A real pet reports the popup the moment it is on screen. Doing this
        // immediately is what parks the notice in `shown` before the page can
        // observe it, which is the state the D2 acceptance case needs.
        void control('/ack', { v: 1, noticeId: event.noticeId, action: 'shown' })
          .then(result => log(`  auto-ack shown ${event.noticeId} -> ${JSON.stringify(result)}`))
      }
      return
    }
    case 'notice/seen': {
      if (shown.delete(event.noticeId)) log(`${label} notice/seen -> CANCEL POPUP notice=${event.noticeId}`)
      else log(`${label} notice/seen for a popup that is not shown (ignored)`)
      return
    }
    case 'running':
      log(`${label} running${event.tool ? ` tool=${event.tool}` : ''} run=${event.runId ?? '-'}`)
      return
    case 'error':
      log(`${label} ERROR ${event.message ?? ''}`)
      return
    case 'idle':
      log(`${label} idle${event.message ? ` (${event.message})` : ''}`)
      return
    case 'session/removed':
      log(`${label} removed`)
      return
    default:
      log(`${label} ${JSON.stringify(event)}`)
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/event' && req.method === 'POST') {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        handleEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        log(`unparsable event: ${String(error)}`)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false,"reason":"not-found"}')
})

server.listen(port, '127.0.0.1', async () => {
  log(`mock pet listening on 127.0.0.1:${port}`)
  if (!autoHandshake) {
    log('handshake disabled; waiting for events only')
  } else {
    const ready = readBridgeFile()
    if (!ready) {
      log('no ~/.dsh/pet-bridge.json yet; is the DSH plugin running?')
    } else {
      const hello = await control('/hello', {
        v: 1,
        petVersion: 'mock-pet',
        port,
        ...(noCapabilities ? {} : { capabilities: CAPABILITIES }),
      })
      log(`hello -> ${JSON.stringify(hello)}`)
      // Say the negotiation out loud: the host's `agreed` is what it will rely
      // on, and `legacy` is the host's reading of "declared nothing" — the two
      // readings this receiver exists to keep apart (PL-PR-NW-02).
      log(`negotiated: agreed=[${(hello?.agreed ?? []).join(',')}]`
        + `${hello?.legacy === true ? ' (legacy handshake: no capability declaration)' : ''}`)
      const state = await readState()
      if (state !== null) {
        log(`/state -> ${state.sessions?.length ?? 0} session(s), ${state.notices?.length ?? 0} notice(s)`)
        for (const notice of state.notices ?? []) {
          if (notice.state === 'pending' && notice.delivered === false) {
            shown.set(notice.noticeId, notice)
            log(`  aligning: SHOW POPUP notice=${notice.noticeId} session=${notice.sessionId}`)
          }
        }
      }
    }
  }
  log('commands: seen <noticeId> | dismiss <noticeId> | state | popups | quit')
})

const rl = createInterface({ input: process.stdin })
/*
 * Run as a background job, stdin is a pipe that may be closed under us. Without
 * this guard an EPIPE on the readline stream is an unhandled 'error' and takes
 * the mock pet down mid-acceptance — after it has already handed the host a
 * handshake, which would look like the plugin losing its pet.
 */
process.stdin.on('error', () => {})
rl.on('line', async (line) => {
  const [command, argument] = line.trim().split(/\s+/)
  switch (command) {
    case 'seen':
    case 'dismiss': {
      const noticeId = argument ?? [...shown.keys()][0]
      if (noticeId === undefined) {
        log('no popup to act on')
        return
      }
      const result = await control('/ack', { v: 1, noticeId, action: command === 'seen' ? 'shown' : 'dismissed' })
      log(`ack ${command} ${noticeId} -> ${JSON.stringify(result)}`)
      if (command === 'dismiss') shown.delete(noticeId)
      return
    }
    case 'state': {
      const state = await readState()
      log(JSON.stringify(state, null, 2))
      return
    }
    case 'popups':
      log(shown.size === 0 ? 'no popups' : [...shown.keys()].join('\n'))
      return
    case 'quit':
    case 'exit':
      rl.close()
      server.close(() => { process.exit(0) })
      return
    case '':
      return
    default:
      log(`unknown command: ${command}`)
  }
})

process.on('SIGINT', () => {
  server.close(() => { process.exit(0) })
})
