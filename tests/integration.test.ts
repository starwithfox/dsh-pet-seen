/**
 * End-to-end tests over the real loopback transports.
 *
 * Nothing is stubbed at the HTTP boundary: a fake pet really listens on a port,
 * the plugin really pushes to it, and the control listener really answers. That
 * covers the part unit tests cannot reach — that the handshake, the push path,
 * and the `/state` snapshot agree with each other.
 *
 * The harness itself *is* stubbed (a fake context replays `session/event` and
 * `agent/status`, and the optional WebServer arrives as a double when a case asks
 * for one), so this half stays verifiable without a running DSH. Wiring the same
 * code to a real DSH is the P0 verification step recorded in
 * DELIVERY-ROUND1.md.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { bridge } from './harness.js'
import { fakeWebServer } from './web-server-fixture.js'
import type { FakeWebServer } from './web-server-fixture.js'

const { BROWSER_ROUTES, BUILD_ID, PLUGIN_VERSION, PROTOCOL_VERSION, apply } = bridge

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
  readonly emitAgentError: (payload: unknown) => void
  readonly controlPort: number
  readonly token: string
  /**
   * The mounted browser routes, or null for the default headless shape.
   *
   * Only a case that asked for `browserRoutes: true` gets one; the rest of the
   * suite pins the headless shape, where the optional injection must not fire.
   */
  readonly browser: FakeWebServer | null
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
 * @param options - `browserRoutes` mounts the real browser routes against a
 *   WebServer double. Off by default: the headless shape is what most of this
 *   suite is about, and `assert.equal(empty.body?.browserRoutes, false)` pins it.
 * @returns captured listeners plus the bound control endpoint.
 */
async function startPlugin(
  petPort: number,
  options: { browserRoutes?: boolean } = {},
): Promise<Harness> {
  let sessionEvent: Harness['emitSessionEvent'] | null = null
  let agentStatus: Harness['emitAgentStatus'] | null = null
  let agentError: Harness['emitAgentError'] | null = null
  const disposers: Array<() => void | Promise<void>> = []
  const browser = options.browserRoutes === true ? fakeWebServer() : null
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
      if (name === 'agent/error') agentError = listener as Harness['emitAgentError']
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
      // The tests exercise the headless shape by default: no WebServer service
      // exists, so the optional browser-route injection must simply not fire.
      // A case that is about the routes asks for the double explicitly.
      if (names.includes('webServer')) {
        if (browser === null) return
        callback({
          get: (name: string) => (name === 'webServer' ? browser.face : undefined),
          effect: (cb) => {
            const disposer = cb()
            if (typeof disposer === 'function') disposers.push(disposer)
            return () => {}
          },
        })
        return () => {}
      }
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
    get emitAgentError() {
      assert.ok(agentError !== null, 'agent/error listener captured')
      return agentError
    },
    controlPort: endpoint.port,
    token: endpoint.token,
    browser,
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

  /*
   * The one end-to-end claim the route tests cannot make: the diagnostics a page
   * sends reach `GET /state`, through the real `apply()` wiring and the real
   * control listener, rather than only out of `BrowserRoutes.diagnostics()`.
   *
   * Both carriers are exercised here, because they answer different questions:
   * a named session carries the read as a session fact, and a page that named
   * none — the drift case — can only appear in `browserTabs`.
   *
   * Since step 6.1 the same snapshot carries the build handshake, and this is
   * where the *shape* of the host's answer is pinned: it states its own build
   * and each tab's report of the same fact, and it renders no verdict about
   * them. A host that compared the two and published "stale: true" would hide
   * which half is behind, and would put the judgement in a second place.
   */
  it('publishes a page\'s session-read diagnostics in /state', async () => {
    const harness = await startPlugin(pet.port, { browserRoutes: true })
    try {
      assert.ok(harness.browser !== null, 'the browser routes were mounted')
      const empty = await controlGet(harness.controlPort, '/state', harness.token)
      assert.equal(empty.body?.browserRoutes, true)
      assert.deepEqual(empty.body?.browserTabs, [], 'no page has reported yet')
      assert.equal(empty.body?.buildId, BUILD_ID, 'the host states its own build')
      assert.equal(empty.body?.pluginVersion, PLUGIN_VERSION)
      assert.equal(typeof empty.body?.buildId, 'string')
      assert.notEqual(empty.body?.buildId, '')

      const blind = await harness.browser.call({
        method: 'POST',
        path: BROWSER_ROUTES.visibility,
        body: {
          v: PROTOCOL_VERSION,
          tabId: 'tab-1',
          sessionId: null,
          visible: true,
          focused: true,
          reader: -1,
          readerReason: 'no-read-answered',
          byIdCount: 152,
          // Deliberately *not* this host's build: a `file:` install that was
          // never refreshed looks exactly like this, and the snapshot has to
          // report it rather than reconcile it.
          buildId: 'build-from-another-install',
        },
      })
      assert.equal(blind.status, 200)

      const afterBlind = await controlGet(harness.controlPort, '/state', harness.token)
      const tabs = afterBlind.body?.browserTabs as Array<Record<string, unknown>>
      assert.equal(tabs.length, 1)
      assert.equal(tabs[0]?.tabId, 'tab-1')
      assert.equal(tabs[0]?.sessionId, null)
      assert.equal(tabs[0]?.reader, -1)
      assert.equal(tabs[0]?.readerReason, 'no-read-answered')
      assert.equal(tabs[0]?.byIdCount, 152)
      assert.equal(tabs[0]?.buildId, 'build-from-another-install', 'the tab\'s claim, verbatim')
      assert.notEqual(afterBlind.body?.buildId, tabs[0]?.buildId, 'a mixture is visible, not resolved')
      // Nothing to attach a session fact to, so nothing is invented.
      assert.deepEqual(afterBlind.body?.sessions, [])

      const named = await harness.browser.call({
        method: 'POST',
        path: BROWSER_ROUTES.visibility,
        body: {
          v: PROTOCOL_VERSION,
          tabId: 'tab-2',
          sessionId: 'session-1',
          visible: true,
          focused: true,
          title: 'a session',
          reader: 0,
          readerReason: 'uiSession.adapter.current',
          byIdCount: 3,
          buildId: BUILD_ID,
        },
      })
      assert.equal(named.status, 200)

      const afterNamed = await controlGet(harness.controlPort, '/state', harness.token)
      const sessions = afterNamed.body?.sessions as Array<Record<string, unknown>>
      assert.equal(sessions[0]?.sessionId, 'session-1')
      assert.equal(sessions[0]?.title, 'a session')
      assert.equal(sessions[0]?.reader, 0)
      const bothTabs = afterNamed.body?.browserTabs as Array<Record<string, unknown>>
      assert.deepEqual(bothTabs.map(tab => tab.tabId).sort(), ['tab-1', 'tab-2'])
      assert.deepEqual(
        bothTabs.map(tab => tab.buildId).sort(),
        [BUILD_ID, 'build-from-another-install'].sort(),
        'each tab is reported with the build it named',
      )
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

  it('never forwards error text to the pet', async () => {
    // The claim in README §4.4 is about this exact data path:
    // `agent/error` -> the message the pet receives. Shape- and length-only
    // assertions on `buildEvent` cannot see it, which is how the raw string used
    // to cross the wire.
    const harness = await startPlugin(pet.port)
    try {
      await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })

      const before = pet.received.length
      const session = { id: 'session-err', header: {} }
      const secret = 'the user asked about hunter2'
      harness.emitAgentError({
        agent: { session, status: 'idle' },
        error: { code: 'ECONNRESET', message: `${secret} / C:\\Users\\star_fox\\private\\notes.md` },
      })

      await waitFor(
        () => pet.received.slice(before).some(event => event.hook === 'agent/error'),
        'the agent/error report',
      )
      const pushed = pet.received.slice(before)
      const report = pushed.find(event => event.hook === 'agent/error')
      assert.ok(report !== undefined)

      // Only the whitelisted category crosses, and it is a closed set.
      assert.equal(report.message, '运行出错：网络连接失败')
      const serialized = JSON.stringify(pushed)
      assert.equal(serialized.includes('hunter2'), false, 'a restated prompt never crossed')
      assert.equal(serialized.includes('notes.md'), false, 'a local path never crossed')
      assert.equal(serialized.includes('ECONNRESET'), false, 'the raw code never crossed')
      assert.equal(serialized.includes('private'), false)
      // A failure during the run is not a result: nothing for the pet to pop.
      assert.equal(report.noticeId, undefined, 'a running failure carries no notice')
    } finally {
      harness.dispose()
    }
  })

  it('reports a settled error as an error event with a notice', async () => {
    const harness = await startPlugin(pet.port)
    try {
      await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })

      const before = pet.received.length
      const session = { id: 'session-failed', header: {} }
      const now = Date.now()
      harness.emitAgentStatus({ agent: { session, status: 'running' }, status: 'running' })
      harness.emitSessionEvent(session, {
        type: 'turn/end',
        seq: 1,
        time: now,
        data: { turn: 7, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'kaboom' } } },
      })
      harness.emitAgentStatus({ agent: { session, status: 'idle' }, status: 'idle' })

      await waitFor(
        () => pet.received.slice(before).some(event => event.sessionId === 'session-failed'),
        'the settled run to be reported',
      )
      const pushed = pet.received.slice(before).filter(event => event.sessionId === 'session-failed')
      // A failed run is never announced as a completion.
      assert.equal(pushed.some(event => event.event === 'completed'), false, 'no completed event')
      const result = pushed.find(event => event.event === 'error')
      assert.ok(result !== undefined, 'the result event is named error')
      assert.equal(result.reason, 'error')
      assert.equal(result.targetTurnRef, '7')
      assert.equal(typeof result.noticeId, 'string', 'a failed run still mints a notice')
      assert.equal(JSON.stringify(pushed).includes('kaboom'), false, 'the failure text never crossed')

      const state = await controlGet(harness.controlPort, '/state', harness.token)
      const notices = state.body?.notices as Array<Record<string, unknown>>
      const stored = notices.find(row => row.noticeId === result.noticeId)
      assert.ok(stored !== undefined, 'the notice is retained for alignment')
      assert.equal(stored.reason, 'error')
    } finally {
      harness.dispose()
    }
  })

  it('treats aborted and unrecognized reasons as non-completions', async () => {
    const harness = await startPlugin(pet.port)
    try {
      await controlPost(harness.controlPort, '/hello', {
        v: PROTOCOL_VERSION,
        port: pet.port,
        token: harness.token,
      })

      const before = pet.received.length
      const now = Date.now()
      const stopped = { id: 'session-aborted', header: {} }
      const alien = { id: 'session-alien', header: {} }
      harness.emitAgentStatus({ agent: { session: stopped, status: 'running' }, status: 'running' })
      harness.emitSessionEvent(stopped, {
        type: 'turn/end',
        seq: 1,
        time: now,
        data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
      harness.emitAgentStatus({ agent: { session: stopped, status: 'idle' }, status: 'idle' })
      // A kind no DSH version ships yet: it must not be read as success.
      harness.emitAgentStatus({ agent: { session: alien, status: 'running' }, status: 'running' })
      harness.emitSessionEvent(alien, {
        type: 'turn/end',
        seq: 1,
        time: now,
        data: { turn: 9, reason: { kind: 'timeout' } },
      })
      harness.emitAgentStatus({ agent: { session: alien, status: 'idle' }, status: 'idle' })

      await waitFor(
        () => ['session-aborted', 'session-alien'].every(id =>
          pet.received.slice(before).some(event => event.sessionId === id && event.event === 'idle')),
        'both non-completions to be reported as idle',
      )
      const pushed = pet.received.slice(before).filter(event =>
        event.sessionId === 'session-aborted' || event.sessionId === 'session-alien')
      assert.equal(pushed.some(event => event.event === 'completed'), false, 'nothing claimed success')
      for (const event of pushed.filter(row => row.event === 'idle')) {
        assert.equal(event.noticeId, undefined, 'a non-completion mints no notice')
      }
      assert.equal(
        pushed.some(event => event.reason === 'unknown'),
        true,
        'the unrecognized reason is reported as unknown, not completed',
      )

      const state = await controlGet(harness.controlPort, '/state', harness.token)
      const notices = state.body?.notices as Array<Record<string, unknown>>
      assert.equal(
        notices.some(row => row.sessionId === 'session-aborted' || row.sessionId === 'session-alien'),
        false,
        'no notice exists for a run that did not complete',
      )
    } finally {
      harness.dispose()
    }
  })
})
