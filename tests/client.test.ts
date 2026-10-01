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
 *
 * A case that is about a switch this page has *not* noticed yet must move the
 * session and fire nothing — see the mid-flight suite below before adding a
 * `page.fire(...)` to one of them.
 *
 * `page` itself never fires anything (`fire` is a no-op stub): every case that
 * needs an event must call `page.fire(...)` explicitly, so "did this case
 * announce the switch?" is visible at the call site rather than hidden in the
 * harness.
 */
import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'
import type { ClientContext } from '../src/client/index.js'
import { SEEN_RETRY_COOLDOWN_MS, apply } from '../src/client/index.js'
import {
  FakeObservable,
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

/** The `uiSession` face a test can install, when it wants read 0. */
interface FakeUiSession {
  adapter: { current: FakeObservable<{ key?: string }> }
}

/** A session binding; `key` is absent when there is no current session. */
function bindingOf(key: string | null): { key?: string } {
  return key === null ? {} : { key }
}

/** What the stubbed page reports about itself. */
interface FakePage {
  document: FixtureDocument
  calls: FakeCall[]
  /** The session each `/notices` GET asked about, in order. */
  noticesRequests: string[]
  /** Every visibility report the page sent, in order. */
  visibilityReports: number
  /** Answer one POST; return null to simulate a transport failure. */
  respond: (path: string, body: Record<string, unknown>, index: number) => Record<string, unknown> | null
  /** The `uiSession` service, when the test asked for one. */
  uiSession: FakeUiSession | null
  /** Move the session without announcing it, as a source-less switch does. */
  setSession: (sessionId: string | null) => void
  /**
   * Move the session while also keeping the subscription quiet.
   *
   * `setSession` always tells the host's observable (`emit`), which is what a
   * real switch does. This one replaces the value in place (`FakeObservable.set`)
   * and notifies only when `notify` is true, so a case can put a switch inside an
   * in-flight response *without* the subscription callback pre-empting the
   * re-read under test.
   */
  releaseSession: (sessionId: string | null, notify?: boolean) => void
  /** Fire a window event the client registered for. */
  fire: (event: string) => void
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

/**
 * Put the fake page in place and start the client.
 *
 * The session is a movable value rather than a captured constant, and a
 * `/notices` answer can be held open (`hold`) while the test moves that value.
 * That pair is what makes the in-flight cases testable at all: without a way to
 * release an answer for session A *after* the page has moved to B, the
 * out-of-order behaviour cannot be observed.
 */
function startClient(options: {
  notices: (sessionId: string) => unknown[]
  dwellMs?: number
  respond?: FakePage['respond']
  sessionId?: string | null
  /** Give the page a subscribable `uiSession` service, i.e. read 0. */
  uiSession?: boolean
  /** Hold a `/notices` answer until the returned promise settles. */
  hold?: (sessionId: string, index: number) => Promise<void> | null
  /** Hold a `/visibility` POST (1-based) until the returned promise settles. */
  holdVisibility?: (index: number) => Promise<void> | null
  cooldownMs?: number
}): FakePage {
  const document = new FixtureDocument()
  const calls: FakeCall[] = []
  let sessionId = options.sessionId === undefined ? 'session-1' : options.sessionId
  const uiSession: FakeUiSession | null = options.uiSession === true
    ? { adapter: { current: new FakeObservable<{ key?: string }>(bindingOf(sessionId)) } }
    : null
  const page: FakePage = {
    document,
    calls,
    noticesRequests: [],
    visibilityReports: 0,
    respond: options.respond ?? (() => ({ v: 1, ok: true })),
    uiSession,
    setSession: (next) => {
      sessionId = next
      uiSession?.adapter.current.set(bindingOf(next))
    },
    releaseSession: (next, notify = false) => {
      sessionId = next
      const current = uiSession?.adapter.current
      if (current === undefined) return
      current.set(bindingOf(next))
      if (notify) current.notify()
    },
    fire: () => {},
    dispose: () => {},
  }

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

  /** Window listeners, so a test can drive focus/visibility by hand. */
  const windowListeners = new Map<string, EventListener[]>()
  const fakeWindow = {
    innerHeight: document.viewportHeight,
    scrollY: 0,
    addEventListener: (event: string, listener: EventListener) => {
      const bucket = windowListeners.get(event) ?? []
      bucket.push(listener)
      windowListeners.set(event, bucket)
    },
    removeEventListener: (event: string, listener: EventListener) => {
      const bucket = windowListeners.get(event) ?? []
      const at = bucket.indexOf(listener)
      if (at >= 0) bucket.splice(at, 1)
    },
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
      const asked = new URL(path, 'http://page.test').searchParams.get('sessionId') ?? ''
      page.noticesRequests.push(asked)
      const held = options.hold?.(asked, page.noticesRequests.length)
      if (held !== undefined && held !== null) await held
      return {
        ok: true,
        json: async () => ({
          v: 1,
          revision: 1,
          sessionId,
          notices: options.notices(asked),
          seenDwellMs: options.dwellMs ?? 60,
        }),
      }
    }
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    calls.push({ path, body })
    let held: Promise<void> | null = null
    if (path.endsWith('/visibility')) {
      page.visibilityReports += 1
      held = options.holdVisibility?.(page.visibilityReports) ?? null
    }
    if (held !== null) await held
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
    get: (name: string) => (name === 'uiSession' ? uiSession ?? undefined : undefined),
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
  page.fire = (event) => {
    for (const listener of [...(windowListeners.get(event) ?? [])]) listener({} as Event)
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

/**
 * The invariant of `FIX-DESIGN` §5.1.4 — a switch invalidates everything that
 * was observed for the session the user left — plus the subscription that only
 * narrows the window in which a switch is *noticed*.
 *
 * The cases on the plain `sessions.list` face offer no `subscribe` at all: the
 * generation check has to hold on its own, and a test that let the subscription
 * cover for it would prove nothing about the invariant. The case that holds an
 * answer open while the session moves also deliberately fires **no** window
 * event — a switch this page has not noticed yet leaves the cached generation
 * and session id untouched, so only re-reading the source can catch it, and
 * firing an event here would hide exactly that.
 *
 * The last three install a subscribable `uiSession` (read 0, the read a 0.2.0
 * page answers with): two pin what an emission may and may not do, and one pins
 * the same silent switch on that read — where the value can be replaced without
 * notifying anyone, so the re-read carries the correctness on its own.
 */
describe('client wiring: leaving a session mid-flight', () => {
  /** The body of every `/seen` report, in order. */
  const seenReports = (page: FakePage): Array<Record<string, unknown>> =>
    page.calls.filter(call => call.path.endsWith('/seen')).map(call => call.body)

  it('drops a notices response that lands after the session switched', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const page = startClient({
      sessionId: 'session-a',
      notices: asked => (asked === 'session-a' ? [notice('nA', 3)] : [notice('nB', 3)]),
      hold: asked => (asked === 'session-a' ? held : null),
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => page.noticesRequests.length >= 1, 'the first notices request')
    // Quiet page from here on: the poll is gated by visibility, nothing is
    // subscribed on this face, and no event is fired. A request for B can
    // therefore only come from the *dropped* response — which is what adopting
    // the session it just refused to describe looks like. Nothing else in the
    // client can notice the switch while the page is hidden.
    page.document.visibleState = 'hidden'
    page.setSession('session-b')
    const before = page.noticesRequests.length
    release()

    await waitFor(
      () => page.noticesRequests.slice(before).includes('session-b'),
      'the dropped response to adopt the new session',
      900,
    )
    // ...and it must not have armed a watch target for the session left behind.
    page.document.visibleState = 'visible'
    page.fire('focus')
    await waitFor(() => seenReports(page).length >= 1, 'an observation')
    const reports = seenReports(page)
    assert.deepEqual(
      reports.map(report => report.sessionId),
      ['session-b'],
      'the stale A body must not become the watch target',
    )
    assert.equal(reports[0]?.noticeId, 'nB')
  })

  it('lets the newer session win when two responses arrive out of order', async () => {
    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    const heldA = new Promise<void>(resolve => { releaseA = resolve })
    const heldB = new Promise<void>(resolve => { releaseB = resolve })
    // Later polls are held forever on purpose: this case is about which answer
    // wins, and a fresh answer landing mid-assertion would rewrite the state
    // whichever way the client behaved.
    const heldForever = new Promise<void>(() => {})
    const page = startClient({
      sessionId: 'session-a',
      notices: asked => (asked === 'session-a' ? [notice('nA', 3)] : [notice('nB', 3)]),
      hold: (asked, index) => {
        if (asked === 'session-a') return heldA
        return index === 2 ? heldB : heldForever
      },
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => page.noticesRequests.length >= 1, "A's request")
    page.setSession('session-b')
    // Nothing is subscribed on this face, so the poll is what notices the
    // switch — and B answers first.
    await waitFor(() => page.noticesRequests.length >= 2, "B's request")
    assert.equal(page.noticesRequests[1], 'session-b')
    releaseB()
    await waitFor(() => seenReports(page).length >= 1, 'B to be settled')
    // A's older answer arrives last and must change nothing. Wait long enough
    // for a wrong answer to have produced a report: the earliest a retargeted
    // notice can fire is the next dwell tick plus the dwell it restarts.
    releaseA()
    await sleep(900)

    assert.deepEqual(
      seenReports(page).map(report => report.sessionId),
      ['session-b'],
      'a response from the older generation must not overwrite the newer one',
    )
  })

  it('does not report to a session the user left while the lease refresh was in flight', async () => {
    let releaseVisibility: () => void = () => {}
    const heldVisibility = new Promise<void>(resolve => { releaseVisibility = resolve })
    const page = startClient({
      sessionId: 'session-a',
      notices: asked => [notice(asked === 'session-a' ? 'nA' : 'nB', 3)],
      // Report #1 is the startup one; report #2 is the lease refresh inside
      // `reportSeen()`, and holding it puts the switch inside that await.
      holdVisibility: index => (index === 2 ? heldVisibility : null),
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => page.visibilityReports >= 2, 'the lease refresh before an observation')
    // The page must stay quiet across the switch: no window event is fired and
    // nothing here calls `page.setSession` through a notifying source, so no
    // timer, event or subscription can have synced the new session by the time
    // the held report lands. That is the condition this case exists for — with
    // an event fired here, a cached-value check would look correct and only a
    // re-read of the source can catch it.
    page.setSession('session-b')
    releaseVisibility()

    await waitFor(() => page.noticesRequests.includes('session-b'), 'a request for B')
    await sleep(400)
    assert.deepEqual(
      seenReports(page).filter(report => report.sessionId === 'session-a'),
      [],
      'an abandoned observation must not be sent to the session the user left',
    )
    // The page is still alive after dropping it: B's own notice is settled —
    // on the back of the request the dropped observation itself asked for,
    // because nothing else on this page has announced the switch.
    await waitFor(
      () => seenReports(page).some(report => report.sessionId === 'session-b'),
      "B's observation",
    )
  })

  it('does not send an observation for a session the user left before the POST', async () => {
    let releaseSeenLease: () => void = () => {}
    const heldSeenLease = new Promise<void>(resolve => { releaseSeenLease = resolve })
    const page = startClient({
      sessionId: 'session-a',
      notices: () => [notice('nA', 1, { sessionId: 'session-a' })],
      // Report #1 is the startup one; #2 is the lease refresh inside
      // `reportSeen()`. Waiting for #2 to be *in flight* is what puts the switch
      // below inside that await deterministically, rather than guessing at it.
      holdVisibility: index => (index === 2 ? heldSeenLease : null),
    })
    page.document.setItems([item(1, 'assistant-step', { top: 200, bottom: 900 })])

    await waitFor(() => page.visibilityReports >= 2, 'the observation to reach its lease refresh')
    // Silent switch: the read has moved to B, nothing was fired, and this face
    // has no subscription — so the generation and the cached id are both still
    // A's and neither can answer the question the guard is asking.
    page.setSession('session-b')
    page.document.visibleState = 'hidden'
    releaseSeenLease()
    await sleep(400)

    // Not "was it labelled A" but "was it sent at all": the lease refresh inside
    // the observation is what syncs the session, so a guard that only consults
    // the cached id can *pass* and then post A's observation anyway — the body
    // carries the id the refresh just adopted, while the notice is one the host
    // no longer holds for it. Either way the host answers `session-mismatch` and
    // blacklists the notice for the life of the page.
    assert.deepEqual(
      seenReports(page).map(body => body.noticeId),
      [],
      "the session that was left must not produce an observation under the new one's name",
    )
  })

  it('does not adopt a response that arrives after the session went away', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const page = startClient({
      sessionId: 'session-a',
      notices: () => [notice('nA', 3)],
      hold: () => held,
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => page.noticesRequests.length >= 1, "A's request")
    // Silent again, and this time the session does not come back: selecting no
    // session at all must be caught by the same re-read.
    page.setSession(null)
    release()
    // Long enough for a wrongly adopted notice to have reached a dwell tick.
    await sleep(900)

    assert.deepEqual(seenReports(page), [], 'a notice for a session that is gone must not be reported')
    assert.equal(
      page.noticesRequests.includes(''),
      false,
      'the early exit must not turn a missing session into a query',
    )
  })

  it('lets a silently switched page still watch the new session, despite the stale body', async () => {
    let releaseA: () => void = () => {}
    const heldA = new Promise<void>(resolve => { releaseA = resolve })
    // Both sessions hand the page a notice for turn 3, so whichever body the
    // client ends up arming is a real notice -- what differs is *whose*.
    //
    // Every B answer is held open, for the whole case. That is what removes the
    // poll as a rescue: the run's poll would otherwise answer for B about a
    // second later and quietly re-arm the right notice, letting a degraded
    // client pass. The page stays **visible** (the L2 guard the ladder needs
    // would refuse to report at all while it is hidden), so the holds are what
    // mute the noise instead of a hidden page.
    //
    // A body is therefore still needed to arm B's notice, and the only one this
    // case allows is the answer the refused body itself asks for: the request
    // for B appears immediately, but its response is held too, so B is never
    // reported here. What is asserted is that the page **asks for B at all**
    // after the stale body lands, and does so on its own.
    const held = new Promise<void>(() => {})
    const page = startClient({
      sessionId: 'session-a',
      uiSession: true,
      notices: asked => (asked === 'session-a' ? [notice('nA', 3)] : [notice('nB', 3)]),
      hold: asked => (asked === 'session-a' ? heldA : held),
    })

    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    await waitFor(() => page.noticesRequests.includes('session-a'), "A's first request")
    assert.equal(
      page.uiSession?.adapter.current.subscribeCount,
      1,
      'this case is about read 0 -- the read a 0.2.0 page answers with -- and it does subscribe',
    )
    // Let start-up settle first. `apply()` coalesces a refresh a few hundred
    // milliseconds out, and that timer would otherwise fire *after* the switch
    // below -- making it, rather than the discard branch, the thing that asks
    // about the new session, and letting a degraded client pass.
    await sleep(400)
    const before = page.noticesRequests.length

    // A switch nobody is told about: `releaseSession` replaces the uiSession
    // value in place (`FakeObservable.set`, never `emit`), so the subscription
    // callback does not run, and this case fires no window event either. Nothing
    // has called `syncSession()` since the switch, so the cached generation and
    // session id are both stale -- which is the state only a re-read can
    // resolve. `subscribeCount` staying at 1 is what keeps this case honest.
    page.releaseSession('session-b')
    releaseA()

    // Refusing the body adopts the session it refused to describe and re-queries
    // at once. Nothing else points at B soon: the switch was announced to nobody,
    // this case fires no events, every B answer is held, and the run's own poll
    // is a full second away -- which is why the deadline below is shorter than
    // that second. A degraded client writes the stale body instead, arms *A's*
    // notice through `retarget()` with the id it captured, and only ever reaches
    // B on the next poll; measurably, it is ~1 s against ~5 ms here. This is the
    // only case in the suite that pins the re-read on read 0.
    const releasedAt = Date.now()
    await waitFor(
      () => page.noticesRequests.slice(before).includes('session-b'),
      'the page to ask about the session the stale body belonged to',
      550,
    )
    const elapsed = Date.now() - releasedAt
    assert.equal(
      elapsed < 550,
      true,
      `the request must come from the refused body, not the next poll (took ${elapsed} ms)`,
    )
  })

  it('follows the read that answered, without waiting for the poll', async () => {
    const page = startClient({
      sessionId: 'session-a',
      uiSession: true,
      notices: asked => (asked === 'session-a' ? [notice('nA', 3)] : [notice('nB', 3)]),
    })
    await waitFor(() => page.noticesRequests.includes('session-a'), "A's first request")
    assert.equal(
      page.uiSession?.adapter.current.subscribeCount,
      1,
      'the read that answered is the one that must be followed',
    )

    // Hiding the page silences the poll, so a request for B can only come from
    // the subscription callback.
    page.document.visibleState = 'hidden'
    const before = page.noticesRequests.length
    page.setSession('session-b')
    page.uiSession?.adapter.current.notify()

    await waitFor(
      () => page.noticesRequests.slice(before).includes('session-b'),
      'a request for the new session',
      700,
    )
  })

  it('does not treat an emission without a session change as a switch', async () => {
    let seenAttempts = 0
    const page = startClient({
      sessionId: 'session-a',
      uiSession: true,
      // The host keeps listing the notice; the page's own refusal is what stops
      // it, so clearing that bookkeeping would make the notice reportable again.
      notices: () => [notice('n1', 3)],
      respond: (path) => {
        if (!path.endsWith('/seen')) return { v: 1, ok: true }
        seenAttempts += 1
        return { v: 1, accepted: false, reason: 'already-dismissed' }
      },
    })
    page.document.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])

    await waitFor(() => seenAttempts >= 1, 'the terminal refusal')
    page.uiSession?.adapter.current.notify()
    await sleep(900)
    assert.equal(
      seenAttempts,
      1,
      'an emission that did not move the session must not re-open a refused notice',
    )
  })
})
