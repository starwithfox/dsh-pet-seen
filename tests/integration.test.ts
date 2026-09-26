/**
 * End-to-end tests over the real loopback transports.
 *
 * Nothing is stubbed at the HTTP boundary: a fake pet really listens on a port,
 * the plugin really pushes to it, and the control listener really answers. That
 * covers the part unit tests cannot reach — that the handshake, the push path,
 * and the `/state` snapshot agree with each other.
 *
 * The harness itself *is* stubbed (a fake context replays `session/event` and
 * `agent/status`), so this half stays verifiable without a running DSH. Wiring
 * the same code to a real DSH is the P0 verification step recorded in
 * DELIVERY-ROUND1.md.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { bridge } from './harness.js'

const { PROTOCOL_VERSION, apply } = bridge

/** A fake pet: a listener that records whatever the plugin pushes at it. */
interface FakePet {
  readonly port: number
  readonly received: Array<Record<string, unknown>>
  readonly close: () => Promise<void>
}

/** Start a fake pet on an OS-assigned port. */
async function startFakePet(): Promise<FakePet> {
  const received: Array<Record<string, unknown>> = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/event' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof parsed === 'object' && parsed !== null) received.push(parsed as Record<string, unknown>)
        } catch {
          // Records nothing for an unparsable body; the test then fails on count.
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address !== 'string' ? address.port : 0)
    })
  })
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/** A control response. */
interface ControlResponse {
  readonly status: number
  readonly body: Record<string, unknown> | null
}

/** POST JSON to the control listener. */
async function controlPost(port: number, path: string, body: unknown): Promise<ControlResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await readJson(response) }
}

/** GET from the control listener, with an optional query token. */
async function controlGet(port: number, path: string, token?: string): Promise<ControlResponse> {
  const url = token === undefined
    ? `http://127.0.0.1:${port}${path}`
    : `http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`
  const response = await fetch(url)
  return { status: response.status, body: await readJson(response) }
}

/** Read a response body as a JSON object, or null. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text()
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Captured harness listeners, so a test can replay events through them. */
interface Harness {
  readonly emitSessionEvent: (session: unknown, event: unknown) => void
  readonly emitAgentStatus: (payload: unknown) => void
  readonly controlPort: number
  readonly token: string
  readonly dispose: () => void
}

/**
 * Start the plugin against a fake context and discover its control endpoint.
 *
 * The plugin is configured with `controlPort: 0`, so the OS assigns the port.
 * Both the port and the freshly minted token are published through the plugin's
 * `onControlBound` hook, which is the bundler-visible seam for exactly this.
 * Reading the handshake file instead would race with the file's other writer
 * (the plugin writes it, but so does every other test instance in the process).
 *
 * Every instance here publishes to its **own** file under a fresh temp
 * directory. That is not tidiness: `writeTokenFile` defaults to the shared
 * `~/.dsh/pet-bridge.json`, so an unisolated instance leaves a random port and
 * a dead token in the credentials a *running* DSH depends on — which is what
 * left a live bridge answering 401 to its own pet. The `tokenFile` field is the
 * fix, and `tests/credentials.test.ts` pins the rule.
 *
 * @param petPort - port of the fake pet.
 * @returns captured listeners plus the bound control endpoint.
 */
async function startPlugin(petPort: number): Promise<Harness> {
  let sessionEvent: Harness['emitSessionEvent'] | null = null
  let agentStatus: Harness['emitAgentStatus'] | null = null
  const disposers: Array<() => void | Promise<void>> = []
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-integration-'))
  const tokenFile = join(scratch, 'pet-bridge.json')
  let resolveBound: (bound: { port: number, token: string }) => void = () => {}
  let rejectBound: (error: Error) => void = () => {}
  const bound = new Promise<{ port: number, token: string }>((resolve, reject) => {
    resolveBound = resolve
    rejectBound = reject
  })

  const ctx = {
    on: (name: string, listener: unknown) => {
      if (name === 'session/event') sessionEvent = listener as Harness['emitSessionEvent']
      if (name === 'agent/status') agentStatus = listener as Harness['emitAgentStatus']
      return () => true
    },
    effect: (callback: () => (() => void | Promise<void>) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject: (names: readonly string[], callback: (scoped: {
      get: (name: string) => unknown
      effect: (cb: () => (() => void | Promise<void>) | void) => unknown
    }) => void) => {
      // The tests exercise the headless shape: no WebServer service exists, so
      // the optional browser-route injection must simply not fire.
      if (names.includes('webServer')) return
      callback({
        get: () => undefined,
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

  apply(
    ctx as unknown as Parameters<typeof apply>[0],
    {
      controlPort: 0,
      tokenFile,
      petPort,
      notifyDelayMs: 0,
      petEventTimeoutMs: 500,
      idleGraceMs: 120,
      seenDwellMs: 20,
      maxNotices: 20,
      noticeTtlMs: 60_000,
      includeTitle: true,
    },
    {
      onReady: (hooks) => {
        hooks.onControlBound((result) => {
          if (result.ok) resolveBound({ port: result.port, token: result.token })
          else rejectBound(new Error(`control listener failed: ${result.reason}`))
        })
      },
    },
  )

  const endpoint = await bound
  assert.ok(endpoint.port > 0, 'control listener bound a real port')
  assert.ok(endpoint.token.length > 0, 'a token was minted')
  assert.ok(existsSync(tokenFile), 'the configured token file was published')
  const published = JSON.parse(readFileSync(tokenFile, 'utf8')) as { controlPort?: number, token?: string }
  assert.equal(published.controlPort, endpoint.port, 'the published port is the bound one')
  assert.equal(published.token, endpoint.token, 'the published token is the minted one')

  return {
    get emitSessionEvent() {
      assert.ok(sessionEvent !== null, 'session/event listener captured')
      return sessionEvent
    },
    get emitAgentStatus() {
      assert.ok(agentStatus !== null, 'agent/status listener captured')
      return agentStatus
    },
    controlPort: endpoint.port,
    token: endpoint.token,
    dispose: () => {
      for (const disposer of disposers.splice(0)) void disposer()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

/** Wait until `check` holds, or fail the test after a bounded number of ticks. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  attempts = 150,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Bind an ephemeral port and release it, to get a port nothing listens on. */
async function unusedPort(): Promise<number> {
  const server: Server = createServer()
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address !== 'string' ? address.port : 0)
    })
  })
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

describe('loopback integration', () => {
  let pet: FakePet

  before(async () => { pet = await startFakePet() })
  after(async () => { await pet.close() })

  it('requires the token, accepts a handshake, and records the pet port', async () => {
    const harness = await startPlugin(pet.port)
    try {
      // `/state` enumerates sessions, so it is gated too.
      const unauthorized = await controlGet(harness.controlPort, '/state')
      assert.equal(unauthorized.status, 401)

      const empty = await controlGet(harness.controlPort, '/state', harness.token)
      assert.equal(empty.status, 200)
      assert.equal(empty.body?.browserRoutes, false, 'headless shape has no browser routes')
      // The plugin probes the configured pet port on mount, and this fake pet
      // answers, so the port is already known before any `/hello`.
      await waitFor(
        async () => {
          const probed = await controlGet(harness.controlPort, '/state', harness.token)
          return probed.body?.petPort === pet.port
        },
        'the mount probe to adopt the configured port',
      )

      const badToken = await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: 'not-the-token',
      })
      assert.equal(badToken.status, 401)

      const wrongVersion = await controlPost(harness.controlPort, '/hello', {
        v: 99,
        port: pet.port,
        token: harness.token,
      })
      assert.equal(wrongVersion.status, 400)
      assert.equal(wrongVersion.body?.reason, 'version-mismatch')

      const hello = await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        petVersion: 'test-pet',
        port: pet.port,
        token: harness.token,
      })
      assert.equal(hello.status, 200)
      assert.equal(hello.body?.ok, true)
      assert.equal(hello.body?.petPort, pet.port)

      const afterHello = await controlGet(harness.controlPort, '/state', harness.token)
      assert.equal(afterHello.body?.petPort, pet.port, 'handshake port recorded')

      const unknownAck = await controlPost(harness.controlPort, '/ack', {
        noticeId: 'missing',
        action: 'shown',
        token: harness.token,
      })
      assert.equal(unknownAck.status, 404)

      const badMethod = await fetch(`http://127.0.0.1:${harness.controlPort}/hello`)
      assert.equal(badMethod.status, 405)
      await badMethod.text()
    } finally {
      harness.dispose()
    }
  })

  it('pushes exactly one completed event per run and retires it on ack', async () => {
    const harness = await startPlugin(pet.port)
    try {
      await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })

      const before = pet.received.length
      const session = { id: 'session-A', header: { cwd: 'C:\\work' } }
      const now = Date.now()
      harness.emitAgentStatus({ agent: { session, status: 'running' }, status: 'running' })
      harness.emitSessionEvent(session, { type: 'turn/start', seq: 1, time: now, data: { turn: 1 } })
      harness.emitSessionEvent(session, {
        type: 'tool/call',
        seq: 2,
        time: now,
        data: { callId: 'c1', name: 'read_file', arguments: '{"secret":"do not send"}' },
      })
      harness.emitSessionEvent(session, {
        type: 'turn/end',
        seq: 3,
        time: now,
        data: { turn: 1, reason: { kind: 'completed' } },
      })
      harness.emitAgentStatus({ agent: { session, status: 'idle' }, status: 'idle' })

      await waitFor(
        () => pet.received.slice(before).some(event => event.event === 'completed'),
        'a completed event',
      )
      const pushed = pet.received.slice(before)
      const completed = pushed.filter(event => event.event === 'completed')
      assert.equal(completed.length, 1, 'exactly one completion per run')
      const notice = completed[0]
      assert.ok(notice !== undefined)
      assert.equal(notice.targetTurnRef, '1')
      assert.equal(notice.reason, 'completed')
      assert.equal(notice.seen, false)
      assert.equal(notice.sessionId, 'session-A')
      assert.equal(typeof notice.noticeId, 'string')
      assert.equal(typeof notice.runId, 'string')

      // The privacy boundary, asserted on the bytes that actually crossed.
      const serialized = JSON.stringify(pushed)
      assert.equal(serialized.includes('do not send'), false, 'tool arguments never crossed the wire')
      assert.equal(serialized.includes('secret'), false)
      assert.equal(serialized.includes('read_file'), true, 'the tool *name* is in scope')

      const noticeId = String(notice.noticeId)
      const state = await controlGet(harness.controlPort, '/state', harness.token)
      const notices = state.body?.notices as Array<Record<string, unknown>>
      const stored = notices.find(row => row.noticeId === noticeId)
      assert.ok(stored !== undefined, 'completion is retained for later alignment')
      assert.equal(stored.runId, notice.runId, 'the pushed run id is the stored one')
      assert.equal(stored.targetTurnRef, notice.targetTurnRef)
      assert.equal(stored.delivered, true)

      const ack = await controlPost(harness.controlPort, '/ack', {
        noticeId,
        action: 'dismissed',
        token: harness.token,
      })
      assert.equal(ack.status, 200)
      assert.equal(ack.body?.state, 'dismissed')

      // Idempotence: a repeated dismissal must not recreate a closed popup.
      const again = await controlPost(harness.controlPort, '/ack', {
        noticeId,
        action: 'dismissed',
        token: harness.token,
      })
      assert.equal(again.status, 200)
      assert.equal(again.body?.state, 'dismissed')
    } finally {
      harness.dispose()
    }
  })

  it('keeps parallel sessions in separate buckets', async () => {
    const harness = await startPlugin(pet.port)
    try {
      await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })
      const sessionA = { id: 'session-A2', header: {} }
      const sessionB = { id: 'session-B2', header: {} }
      const now = Date.now()
      harness.emitAgentStatus({ agent: { session: sessionA, status: 'running' }, status: 'running' })
      harness.emitAgentStatus({ agent: { session: sessionB, status: 'running' }, status: 'running' })

      // B finishes; A keeps working.
      harness.emitSessionEvent(sessionB, {
        type: 'turn/end',
        seq: 1,
        time: now,
        data: { turn: 4, reason: { kind: 'completed' } },
      })
      harness.emitAgentStatus({ agent: { session: sessionB, status: 'idle' }, status: 'idle' })

      await waitFor(
        () => pet.received.some(event => event.event === 'completed' && event.sessionId === 'session-B2'),
        'session B completion',
      )
      const state = await controlGet(harness.controlPort, '/state', harness.token)
      const sessions = state.body?.sessions as Array<Record<string, unknown>>
      const rowA = sessions.find(row => row.sessionId === 'session-A2')
      const rowB = sessions.find(row => row.sessionId === 'session-B2')
      assert.equal(rowA?.running, true, 'A is still running')
      assert.equal(rowB?.running, false, 'B is idle')
      assert.notEqual(rowB?.lastTurnEnd, null, 'B kept its turn-end record')
      assert.equal(rowA?.lastTurnEnd, null, 'A never recorded a turn end')
    } finally {
      harness.dispose()
    }
  })

  it('suppresses pushes until a handshake, then recovers through /state', async () => {
    // Start against a port nobody listens on, which is the real "pet is not
    // running yet" case: the mount probe fails and the bridge stays muted.
    const deadPort = await unusedPort()
    const harness = await startPlugin(deadPort)
    try {
      const before = pet.received.length
      const session = { id: 'session-C', header: {} }
      const now = Date.now()
      harness.emitAgentStatus({ agent: { session, status: 'running' }, status: 'running' })
      harness.emitSessionEvent(session, {
        type: 'turn/end',
        seq: 1,
        time: now,
        data: { turn: 2, reason: { kind: 'completed' } },
      })
      harness.emitAgentStatus({ agent: { session, status: 'idle' }, status: 'idle' })
      await new Promise(resolve => setTimeout(resolve, 200))

      // Nothing may reach the real pet: it never handshook on this port.
      assert.equal(
        pet.received.slice(before).some(event => event.sessionId === 'session-C'),
        false,
        'nothing was pushed before the handshake',
      )

      const state = await controlGet(harness.controlPort, '/state', harness.token)
      assert.equal(state.body?.petPort, null, 'a failed probe does not claim the pet is online')
      const notices = state.body?.notices as Array<Record<string, unknown>>
      const retained = notices.find(row => row.sessionId === 'session-C')
      assert.ok(retained !== undefined, 'the notice is retained for a late pet')
      assert.equal(retained.delivered, false)

      // Now the pet starts and handshakes on its real port. The snapshot is how
      // it catches up on what it missed.
      const hello = await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })
      assert.equal(hello.status, 200)
      const after = await controlGet(harness.controlPort, '/state', harness.token)
      assert.equal(after.body?.petPort, pet.port)
      const afterNotices = after.body?.notices as Array<Record<string, unknown>>
      assert.equal(
        afterNotices.some(row => row.sessionId === 'session-C' && row.delivered === false),
        true,
        'the missed completion is still pending in the snapshot',
      )
    } finally {
      harness.dispose()
    }
  })
})
