/**
 * Integration tests for the browser half's wiring.
 *
 * `apply()` is driven for real: the effect body runs, listeners register, and
 * the ladder ticks on real timers. Only the environment is fake — a
 * geometry-assignable document double, a stubbed `fetch`, and a stubbed
 * `sessionStorage` — so what is asserted is the shipping wiring, not a copy of
 * it.
 *
 * The client half reads `document`, `window`, `fetch` and `sessionStorage` as
 * globals, exactly as it does in the page, so the suite installs them around
 * each test and removes them afterwards.
 */
import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'
import type { ClientContext } from '../src/client/index.js'
import { SEEN_RETRY_COOLDOWN_MS, apply } from '../src/client/index.js'
import {
  FixtureDocument,
  item,
  notice,
  sleep,
  waitFor,
} from './client-fixture.js'

interface FakeCall {
  readonly path: string
  readonly body: Record<string, unknown>
}

/** What the stubbed page reports about itself. */
interface FakePage {
  document: FixtureDocument
  calls: FakeCall[]
  /** Every visibility report the page sent, in order. */
  visibilityReports: number
  /** Answer one POST; return null to simulate a transport failure. */
  respond: (path: string, body: Record<string, unknown>, index: number) => Record<string, unknown> | null
  dispose: () => void
}

const installed: Array<() => void> = []

/**
 * The real global `fetch`, captured once.
 *
 * A test disposes the client, but a request already in flight can still settle
 * afterwards and would then reach whatever `fetch` is installed next. The stub
 * is therefore kept for the whole process and only the timing is faked, so a
 * late caller always gets a well-formed response instead of another suite's
 * mock.
 */
const realFetch = globalThis.fetch

/** Put the fake page in place and start the client. */
function startClient(options: {
  notices: () => unknown[]
  dwellMs?: number
  respond?: FakePage['respond']
  sessionId?: string | null
  cooldownMs?: number
}): FakePage {
  const document = new FixtureDocument()
  const calls: FakeCall[] = []
  const page: FakePage = {
    document,
    calls,
    visibilityReports: 0,
    respond: options.respond ?? (() => ({ v: 1, ok: true })),
    dispose: () => {},
  }
  const sessionId = options.sessionId === undefined ? 'session-1' : options.sessionId

  const storage = new Map<string, string>()
  const restore: Array<() => void> = []
  const setGlobal = (key: string, value: unknown): void => {
    const previous = (globalThis as Record<string, unknown>)[key]
    ;(globalThis as Record<string, unknown>)[key] = value
    restore.push(() => {
      if (previous === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = previous
    })
  }

  const fakeWindow = {
    innerHeight: document.viewportHeight,
    scrollY: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const fakeSessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  }

  setGlobal('window', fakeWindow)
  setGlobal('sessionStorage', fakeSessionStorage)
  setGlobal('document', document.asDocument())
  setGlobal('fetch', async (path: string, init: { method?: string, body?: string }) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          v: 1,
          revision: 1,
          sessionId,
          notices: options.notices(),
          seenDwellMs: options.dwellMs ?? 60,
        }),
      }
    }
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    calls.push({ path, body })
    if (path.endsWith('/visibility')) page.visibilityReports += 1
    const answer = page.respond(path, body, calls.length)
    if (answer === null) throw new Error('simulated transport failure')
    return { ok: true, json: async () => answer }
  })

  const session = {
    list: {
      getSnapshot: () => ({
        current: sessionId,
        byId: sessionId === null ? {} : { [sessionId]: { title: 'a session', running: false } },
      }),
    },
  }
  let disposer: (() => void | Promise<void>) | void
  const context: ClientContext = {
    sessions: session,
    effect: (callback) => { disposer = callback() },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(context)

  installed.push(() => {
    void disposer?.()
    for (const undo of restore.reverse()) undo()
  })

  page.dispose = () => {
    void disposer?.()
  }
  return page
}

afterEach(() => {
  while (installed.length > 0) installed.pop()?.()
})

after(() => {
  globalThis.fetch = realFetch
})

/** Paths the page posted to, in order. */
function posted(page: FakePage): string[] {
  return page.calls.map(call => call.path)
}

describe('client wiring: reporting an observation', () => {
  it('refreshes the focus lease before reporting, then settles the notice', async () => {
    const page = startClient({ notices: () => [notice('n1', 3)] })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => posted(page).some(path => path.endsWith('/seen')), 'a /seen report')

    const seen = page.calls.find(call => call.path.endsWith('/seen'))
    assert.equal(seen?.body.noticeId, 'n1')
    assert.equal(seen?.body.runId, 'run-3')
    assert.equal(seen?.body.sessionId, 'session-1')
    assert.equal(seen?.body.observed, true)
    assert.equal(typeof seen?.body.tabId, 'string')
    assert.equal(
      page.visibilityReports >= 1,
      true,
      'the lease must be refreshed before the observation is reported',
    )
    // Exactly once: a settled notice is not reported again.
    await sleep(400)
    assert.equal(page.calls.filter(call => call.path.endsWith('/seen')).length, 1)
  })

  it('does not report while the answer is off screen', async () => {
    const page = startClient({ notices: () => [notice('n1', 3)] })
    page.document.setItems([
      item(3, 'user', { top: 100, bottom: 300 }),
      item(3, 'assistant-step', { top: 5_000, bottom: 9_000 }),
    ])

    await sleep(500)
    assert.deepEqual(posted(page).filter(path => path.endsWith('/seen')), [])
  })

  it('watches a newer visible notice instead of an older off-screen one', async () => {
    const page = startClient({ notices: () => [notice('old', 1), notice('new', 2)] })
    page.document.setItems([
      item(1, 'assistant-step', { top: -9_000, bottom: -6_000 }),
      item(2, 'assistant-step', { top: 300, bottom: 2_000 }),
    ])

    await waitFor(() => posted(page).some(path => path.endsWith('/seen')), 'the newer notice')
    assert.equal(page.calls.find(call => call.path.endsWith('/seen'))?.body.noticeId, 'new')
  })

  it('follows the dwell threshold the host advertises', async () => {
    // 5 s dwell: nothing may be reported inside half a second.
    const page = startClient({ notices: () => [notice('n1', 3)], dwellMs: 5_000 })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await sleep(700)
    assert.deepEqual(posted(page).filter(path => path.endsWith('/seen')), [])
  })
})

describe('client wiring: recovering from a refusal', () => {
  it('retries a transport failure until it lands', async () => {
    let seenAttempts = 0
    const page = startClient({
      notices: () => [notice('n1', 3)],
      respond: (path) => {
        if (!path.endsWith('/seen')) return { v: 1, ok: true }
        seenAttempts += 1
        return null
      },
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => seenAttempts >= 1, 'the first attempt')
    // The transport failed, so the notice stayed watchable and was retried
    // rather than being written off for the life of the page. The retry is
    // spaced by the cooldown, which is a couple of seconds by design.
    await waitFor(
      () => seenAttempts >= 2,
      'a retry after the failure',
      SEEN_RETRY_COOLDOWN_MS + 3_000,
    )
  })

  it('stops retrying a notice the host has terminally refused', async () => {
    let seenAttempts = 0
    const page = startClient({
      notices: () => [notice('n1', 3)],
      respond: (path) => {
        if (!path.endsWith('/seen')) return { v: 1, ok: true }
        seenAttempts += 1
        return { v: 1, accepted: false, reason: 'already-dismissed' }
      },
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => seenAttempts >= 1, 'the first attempt')
    await sleep(900)
    assert.equal(seenAttempts, 1, 'a dismissed notice must not be reported in a loop')
  })

  it('does not report a notice the current session does not have', async () => {
    const page = startClient({ notices: () => [], sessionId: 'session-2' })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    await sleep(400)
    assert.deepEqual(posted(page).filter(path => path.endsWith('/seen')), [])
  })
})
