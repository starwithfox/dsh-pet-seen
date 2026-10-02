/**
 * Browser-route tests: the visibility intake, the per-tab diagnostics it keeps,
 * and the session facts those diagnostics feed.
 *
 * `mountBrowserRoutes()` is the only place a page's report is validated, and
 * until the drift self-check (`FIX-DESIGN` §5.5) it had no direct coverage at
 * all. The integration suite cannot cover it: that suite deliberately runs the
 * *headless* shape, where `inject(['webServer'])` never resolves and the routes
 * are never mounted (see its "headless shape has no browser routes" case).
 *
 * The endpoint carries two independent diagnostics and both are pinned here: the
 * session-read self-check (`reader` and friends) and the **build identity** the
 * page reports (step 6.1). They are read on separate rules on purpose — the read
 * fields are taken as a unit keyed on the read index, the build identity stands
 * alone — so a case that conflates them would hide the difference.
 *
 * The WebServer is stubbed rather than bound to a real port. The handler is the
 * unit under test, and a socket would add flakiness without adding evidence.
 *
 * Every case here is about a value a *page* sent, so the interesting ones are
 * the malformed ones: this is the boundary where a diagnostic becomes host
 * state, and "a number we coerced" is a different claim from "a number we were
 * told".
 */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import {
  BROWSER_ROUTES,
  MAX_BUILD_ID_LENGTH,
  MAX_BY_ID_COUNT,
  MAX_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
} from '../src/protocol.js'
import type { TabDiagnostic } from '../src/protocol.js'
import { DEFAULT_LEASE_TTL_MS, mountBrowserRoutes } from '../src/routes.js'
import type { BrowserRoutes } from '../src/routes.js'
import { NoticeStore } from '../src/state.js'
import { fakeWebServer } from './web-server-fixture.js'
import type { FakeWebServer } from './web-server-fixture.js'

/** A mounted route set with its store and its calling stub. */
interface Mounted {
  readonly routes: BrowserRoutes
  readonly store: NoticeStore
  readonly server: FakeWebServer
}

/** Mount the real routes against a stub server and a fresh store. */
function mount(options: { leaseTtlMs?: number } = {}): Mounted {
  const store = new NoticeStore({ maxNotices: 100, noticeTtlMs: 24 * 60 * 60 * 1000, idleGraceMs: 1500 })
  const server = fakeWebServer()
  const routes = mountBrowserRoutes({
    store,
    webServer: server.face,
    seenDwellMs: 20,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
  })
  return { routes, store, server }
}

/**
 * The body a current page sends.
 *
 * @param overrides - fields to replace, including the ones a case wants absent
 *   (deleted after the fact, so `reader: undefined` cannot be sent by accident).
 */
function report(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    tabId: 'tab-1',
    sessionId: 'session-1',
    visible: true,
    focused: true,
    title: 'a session',
    reader: 0,
    readerReason: 'uiSession.adapter.current',
    byIdCount: 3,
    buildId: 'build-under-test',
    ...overrides,
  }
}

/** A diagnostic row without its clock, for exact comparisons. */
function fields(row: TabDiagnostic | undefined): Omit<TabDiagnostic, 'at'> | null {
  if (row === undefined) return null
  return {
    tabId: row.tabId,
    sessionId: row.sessionId,
    reader: row.reader,
    readerReason: row.readerReason,
    byIdCount: row.byIdCount,
    buildId: row.buildId,
  }
}

describe('browser routes: the visibility intake', () => {
  it('registers exactly the three documented paths', (t) => {
    const { routes, server } = mount()
    t.after(() => routes.dispose())
    assert.deepEqual(server.registered(), [
      BROWSER_ROUTES.visibility,
      BROWSER_ROUTES.notices,
      BROWSER_ROUTES.seen,
    ])
    assert.deepEqual(routes.paths, server.registered())
  })

  it('keeps the read index of a tab that found no session', async (t) => {
    const { routes, store, server } = mount()
    t.after(() => routes.dispose())

    const answer = await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ sessionId: null, title: null, reader: -1, readerReason: 'no-read-answered', byIdCount: 152 }),
    })

    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.deepEqual(fields(routes.diagnostics()[0]), {
      tabId: 'tab-1',
      sessionId: null,
      reader: -1,
      readerReason: 'no-read-answered',
      byIdCount: 152,
      buildId: 'build-under-test',
    })
    // The whole point of the separate field: this reading has no session to be a
    // fact about, and must not invent one.
    assert.deepEqual(store.progressSnapshot(), [])
  })

  it('never records a "no read" against a session the same report named', async (t) => {
    const { routes, store, server } = mount()
    t.after(() => routes.dispose())

    // Self-contradictory on purpose: a buggy page could send both, and the host
    // must not turn that into a claim about the session.
    await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ sessionId: 'session-1', reader: -1, readerReason: 'no-read-answered' }),
    })

    assert.equal(store.progressSnapshot()[0]?.reader, undefined)
    assert.equal(routes.diagnostics()[0]?.reader, -1, 'the tab row still says what the page saw')
  })

  it('records the read index as a session fact when a session was named', async (t) => {
    const { routes, store, server } = mount()
    t.after(() => routes.dispose())

    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: report() })

    const [session] = store.progressSnapshot()
    assert.equal(session?.sessionId, 'session-1')
    assert.equal(session?.title, 'a session')
    assert.equal(session?.reader, 0)
    assert.equal(fields(routes.diagnostics()[0])?.reader, 0)
  })

  it('drops a malformed read index instead of coercing it', async (t) => {
    const { routes, store, server } = mount()
    t.after(() => routes.dispose())

    for (const reader of [7, -2, 1.5, '0', true, null]) {
      const answer = await server.call({
        method: 'POST',
        path: BROWSER_ROUTES.visibility,
        body: report({ reader, readerReason: 'from-a-bad-report', byIdCount: 4 }),
      })
      // A bad diagnostic is not a bad request: the lease half is still valid,
      // and refusing the report would cost the page its ability to observe.
      assert.equal(answer.status, 200)
      assert.deepEqual(fields(routes.diagnostics()[0]), {
        tabId: 'tab-1',
        sessionId: 'session-1',
        reader: null,
        readerReason: null,
        byIdCount: null,
        buildId: 'build-under-test',
      })
    }
    assert.equal(store.progressSnapshot()[0]?.reader, undefined)

    // ...and a good report right after is still accepted.
    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: report({ reader: 1 }) })
    assert.equal(routes.diagnostics()[0]?.reader, 1)
  })

  it('bounds what a report can put into the snapshot', async (t) => {
    const { routes, server } = mount()
    t.after(() => routes.dispose())

    await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ reader: 2, readerReason: 'x'.repeat(400), byIdCount: 10 ** 9 }),
    })
    const clamped = routes.diagnostics()[0]
    assert.equal(clamped?.reader, 2)
    assert.equal(clamped?.readerReason?.length, MAX_MESSAGE_LENGTH)
    assert.equal(clamped?.byIdCount, MAX_BY_ID_COUNT)

    await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ reader: 2, readerReason: '', byIdCount: -1 }),
    })
    const rejected = routes.diagnostics()[0]
    assert.equal(rejected?.readerReason, null, 'an empty reason is no reason')
    assert.equal(rejected?.byIdCount, null, 'a negative count is not a count')
  })

  it('keeps the last real answer when a later report omits the diagnostics', async (t) => {
    const { routes, server } = mount()
    t.after(() => routes.dispose())

    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: report() })

    // The `pagehide` shape: an older client, or this one's own withdrawal.
    const withdrawal = report({ visible: false, focused: false })
    delete withdrawal.reader
    delete withdrawal.readerReason
    delete withdrawal.byIdCount
    delete withdrawal.buildId
    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: withdrawal })

    const row = routes.diagnostics()[0]
    assert.equal(row?.reader, 0, 'a withdrawal must not blank the last reading')
    assert.equal(row?.readerReason, 'uiSession.adapter.current')
    assert.equal(row?.byIdCount, 3)
    assert.equal(row?.sessionId, 'session-1')
    // Same rule for the build identity: it is a separate field read on its own
    // (the two arrived in different steps), but a body that omits it is still
    // "no report", not "report nothing".
    assert.equal(row?.buildId, 'build-under-test', 'a withdrawal must not blank the build identity')
  })

  it('records the build identity a tab reports, bounded', async (t) => {
    const { routes, server } = mount()
    t.after(() => routes.dispose())

    await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ buildId: 'another-build' }),
    })
    assert.equal(routes.diagnostics()[0]?.buildId, 'another-build')

    // Oversized values are clamped like every other diagnostic, and a value that
    // is not a non-empty string keeps the previous one instead of becoming a
    // claim about a build the page never named.
    await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      body: report({ buildId: 'x'.repeat(400) }),
    })
    const clamped = routes.diagnostics()[0]?.buildId
    assert.equal(clamped?.length, MAX_BUILD_ID_LENGTH)

    for (const buildId of [7, null, true, {}, '']) {
      await server.call({
        method: 'POST',
        path: BROWSER_ROUTES.visibility,
        body: report({ buildId }),
      })
      assert.equal(
        routes.diagnostics()[0]?.buildId,
        clamped,
        `a ${JSON.stringify(buildId)} build identity is no report and must not blank the last one`,
      )
    }

    // ...and a good report right after is still accepted.
    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: report({ buildId: 'third' }) })
    assert.equal(routes.diagnostics()[0]?.buildId, 'third')
  })

  it('stops reporting a tab once its lease has gone stale', async (t) => {
    const { routes, server } = mount({ leaseTtlMs: 20 })
    t.after(() => routes.dispose())

    await server.call({ method: 'POST', path: BROWSER_ROUTES.visibility, body: report() })
    assert.equal(routes.diagnostics().length, 1)

    await sleep(60)
    // The bound is the lease, not a table of its own: a tab that stopped
    // reporting stops being diagnosable, which is what keeps this from growing.
    assert.deepEqual(routes.diagnostics(), [])
  })

  it('refuses a cross-origin report and records nothing from it', async (t) => {
    const { routes, server } = mount()
    t.after(() => routes.dispose())

    const answer = await server.call({
      method: 'POST',
      path: BROWSER_ROUTES.visibility,
      origin: 'http://evil.test',
      body: report({ reader: -1, byIdCount: 152 }),
    })

    assert.equal(answer.status, 403)
    assert.deepEqual(routes.diagnostics(), [])
  })
})
