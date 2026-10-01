/**
 * Tests for the page half's decisions.
 *
 * These call the shipping logic in `src/client/decide.ts` directly. The three
 * defects of this round live here: picking a watch target that is not blocked
 * by an off-screen older notice (D3), treating a transient refusal as
 * retryable rather than as a lifetime ban (D4), and accepting the host's dwell
 * threshold (D5). The session-current chain is here for the same reason — which
 * read answers is a pure decision, and it is the one 0.2.0 moved.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TERMINAL_SEEN_REASONS,
  classifySeenOutcome,
  createAttemptGate,
  currentSessionObservable,
  resolveCurrentSession,
  resolveDwellMs,
  selectWatchTarget,
  turnOf,
  watchableCandidates,
} from '../src/client/decide.js'
import type { SessionRow, SessionsFace, SessionsListSnapshot } from '../src/client/decide.js'
import { notice } from './client-fixture.js'

describe('D3: choosing what to watch', () => {
  it('picks a visible notice over an older one that is off screen', () => {
    const candidates = watchableCandidates([notice('old', 1), notice('new', 2)], new Set())
    const selection = selectWatchTarget(candidates, 'session-1', turn => turn === 2)
    assert.equal(selection.visible, true)
    assert.deepEqual(selection.target, { sessionId: 'session-1', noticeId: 'new', turn: 2 })
  })

  it('keeps the oldest notice when every result is off screen', () => {
    const candidates = watchableCandidates([notice('old', 1), notice('new', 2)], new Set())
    const selection = selectWatchTarget(candidates, 'session-1', () => false)
    // Nothing is on screen, so the oldest is watched and its dwell simply
    // starts whenever the user scrolls to it.
    assert.equal(selection.visible, false)
    assert.equal(selection.target?.noticeId, 'old')
  })

  it('never selects an already reported notice', () => {
    const candidates = watchableCandidates(
      [notice('old', 1), notice('new', 2)],
      new Set(['old']),
    )
    assert.deepEqual(candidates.map(candidate => candidate.notice.noticeId), ['new'])
  })

  it('skips notices with no usable turn reference', () => {
    const rows = [
      notice('no-turn', 1, { targetTurnRef: null }),
      notice('bad-turn', 1, { targetTurnRef: 'turn-1' }),
      notice('good', 3),
    ]
    assert.deepEqual(
      watchableCandidates(rows, new Set()).map(candidate => candidate.notice.noticeId),
      ['good'],
    )
    assert.equal(turnOf(notice('x', 1, { targetTurnRef: null })), null)
    assert.equal(turnOf(notice('x', 1, { targetTurnRef: '-2' })), null)
    assert.equal(turnOf(notice('x', 1, { targetTurnRef: '0' })), 0)
  })

  it('reports having nothing to watch when there are no candidates', () => {
    const selection = selectWatchTarget([], 'session-1', () => true)
    assert.equal(selection.target, null)
    assert.equal(selection.considered, 0)
  })

  it('confirms several notices one after another', () => {
    const blocked = new Set<string>()
    let candidates = watchableCandidates([notice('a', 1), notice('b', 2), notice('c', 3)], blocked)
    const visibleTurn = 3
    // 'a' is off screen, 'c' is on screen: the page must not stall on 'a'.
    assert.equal(
      selectWatchTarget(candidates, 's', turn => turn === visibleTurn).target?.noticeId,
      'c',
    )
    blocked.add('c')
    candidates = watchableCandidates([notice('a', 1), notice('b', 2), notice('c', 3)], blocked)
    assert.equal(selectWatchTarget(candidates, 's', () => true).target?.noticeId, 'a')
    blocked.add('a')
    candidates = watchableCandidates([notice('a', 1), notice('b', 2), notice('c', 3)], blocked)
    assert.equal(selectWatchTarget(candidates, 's', () => false).target?.noticeId, 'b')
  })
})

describe('D4: what a refused report means', () => {
  it('treats an accepted observation as verified', () => {
    assert.equal(classifySeenOutcome(true), 'verified')
  })

  it('retries a race that can still be won', () => {
    for (const reason of ['no-effective-lease', 'tab-not-on-session', 'something-new']) {
      assert.equal(classifySeenOutcome(false, reason), 'retry', reason)
    }
  })

  it('retries a response that never arrived', () => {
    assert.equal(classifySeenOutcome(false), 'retry')
    assert.equal(classifySeenOutcome(false, ''), 'retry')
  })

  it('stops on a terminal refusal', () => {
    for (const reason of TERMINAL_SEEN_REASONS) {
      assert.equal(classifySeenOutcome(false, reason), 'stop', reason)
    }
  })

  it('rate-limits attempts without banning the notice', () => {
    const gate = createAttemptGate(5_000)
    assert.equal(gate.canAttempt('n1', 1_000), true)
    gate.remember('n1', 1_000)
    assert.equal(gate.canAttempt('n1', 3_000), false)
    assert.equal(gate.canAttempt('n1', 6_200), true)
    // Other notices are unaffected.
    assert.equal(gate.canAttempt('n2', 3_000), true)
    gate.forget('n1')
    assert.equal(gate.canAttempt('n1', 3_000), true)
    gate.remember('n1', 3_000)
    gate.clear()
    assert.equal(gate.canAttempt('n1', 3_000), true)
  })
})

describe('D5: the dwell threshold comes from the host', () => {
  it('accepts a usable advertised value', () => {
    assert.equal(resolveDwellMs(2_500, 1_500), 2_500)
    assert.equal(resolveDwellMs(0, 1_500), 0)
  })

  it('falls back instead of disabling confirmation', () => {
    for (const value of [undefined, null, 'soon', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(resolveDwellMs(value, 1_500), 1_500, String(value))
    }
  })
})

/* -------------------------------------------------------------------------- *
 * The session-current chain.
 *
 * `reader` is asserted in every case: it is the value that gets reported as the
 * drift signal, so "the right id came back" is only half the property. The two
 * runtime faces are pinned separately (0.1.5 answers with `list.current`, 0.2.0
 * no longer has it) because that is exactly what moved.
 * -------------------------------------------------------------------------- */

/** A `HostObservable` double; `onSubscribe` records that someone subscribed. */
function viewOf(key: unknown, onSubscribe?: () => void): unknown {
  return {
    getSnapshot: () => ({ key }),
    subscribe: () => {
      onSubscribe?.()
      return () => {}
    },
  }
}

/**
 * A `sessions.list` snapshot double.
 *
 * `current` is omitted rather than set to undefined when the case does not pass
 * one, which is how 0.2.0 ships the snapshot.
 */
function listOf(rows: Record<string, SessionRow>, current?: string | null): SessionsListSnapshot {
  return current === undefined ? { byId: rows } : { current, byId: rows }
}

/** A `sessions` service double. */
function sessionsOf(rows: Record<string, SessionRow>, current?: string | null): SessionsFace {
  return { list: { getSnapshot: () => listOf(rows, current) } }
}

/** A row the main view is showing. */
function retained(title: string): SessionRow {
  return { title, retainedBy: { mainView: 1 } }
}

/** An observable whose read blows up, as a torn-down service would. */
const throwingView = {
  getSnapshot: (): never => { throw new Error('service is not ready') },
}

describe('session current: which of the four reads answers', () => {
  it('reads the public adapter binding on the 0.1.5 face, and only reads', () => {
    let subscribes = 0
    const source = {
      uiSession: { adapter: { current: viewOf('session-old', () => { subscribes += 1 }) } },
      sessions: sessionsOf({ 'session-old': { title: 'old' } }, 'session-old'),
    }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: 'session-old', title: 'old', reader: 0 },
    )
    // Reading the session and observing it are separate changes: this one is
    // read-only, so a source that is never subscribed still resolves.
    assert.equal(subscribes, 0)
  })

  it('reads the same binding on the 0.2.0 face, where the list has no current', () => {
    const source = {
      uiSession: { adapter: { current: viewOf('session-new') }, current: viewOf('session-new') },
      sessions: sessionsOf({ 'session-new': retained('new') }),
    }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: 'session-new', title: 'new', reader: 0 },
    )
  })

  it('falls back to the 0.2.0 alias when adapter is gone', () => {
    const source = {
      uiSession: { current: viewOf('session-new') },
      sessions: sessionsOf({ 'session-new': retained('new') }),
    }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: 'session-new', title: 'new', reader: 1 },
    )
  })

  it('falls back to list.current when uiSession is missing entirely', () => {
    const source = { sessions: sessionsOf({ 'session-old': { title: 'old' } }, 'session-old') }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: 'session-old', title: 'old', reader: 2 },
    )
  })

  it('falls back to the row the main view retains when nothing else answers', () => {
    const source = {
      uiSession: {},
      sessions: sessionsOf({ 'not-retained': {}, 'session-new': retained('new') }),
    }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: 'session-new', title: 'new', reader: 3 },
    )
  })

  it('reports having no session when none of the four reads answers', () => {
    const source = {
      uiSession: {},
      sessions: sessionsOf({
        'not-retained': { title: 'x' },
        'retained-by-nobody': { title: 'y', retainedBy: { mainView: 0 } },
      }),
    }
    assert.deepEqual(
      resolveCurrentSession(source),
      { sessionId: null, title: null, reader: -1 },
    )
  })

  it('degrades one read at a time instead of throwing', () => {
    // A throwing source costs one step, not the chain.
    assert.equal(
      resolveCurrentSession({
        uiSession: { adapter: { current: throwingView }, current: viewOf('from-alias') },
      }).reader,
      1,
      'a throwing adapter must degrade to the alias',
    )
    // An empty key is not a session id, so the next read gets its turn.
    assert.deepEqual(
      resolveCurrentSession({
        uiSession: { adapter: { current: viewOf('') } },
        sessions: sessionsOf({}, 'from-list'),
      }),
      { sessionId: 'from-list', title: null, reader: 2 },
    )
    // Neither is a non-string key.
    assert.equal(
      resolveCurrentSession({
        uiSession: { adapter: { current: viewOf(42) }, current: viewOf(null) },
      }).reader,
      -1,
    )
    // A malformed or absent service is a missing service, not a crash.
    assert.equal(resolveCurrentSession({ uiSession: 'not-a-service' }).reader, -1)
    assert.equal(resolveCurrentSession({}).reader, -1)
    // A throwing `sessions` must not stop the `uiSession` read...
    const badSessions = {
      list: { getSnapshot: () => { throw new Error('no sessions') } },
    } as unknown as SessionsFace
    assert.equal(
      resolveCurrentSession({
        uiSession: { adapter: { current: viewOf('from-adapter') } },
        sessions: badSessions,
      }).reader,
      0,
    )
    // ...and an id found without a readable list still resolves, just titleless.
    assert.deepEqual(
      resolveCurrentSession({ uiSession: { adapter: { current: viewOf('lonely') } } }),
      { sessionId: 'lonely', title: null, reader: 0 },
    )
  })
})

/* -------------------------------------------------------------------------- *
 * Which source a switch is noticed through.
 *
 * This is the other half of the chain: `resolveCurrentSession()` says *which*
 * session is current and reports the hit index, and this says which observable
 * that index came from. Reads 2 and 3 share `sessions.list`, so they must share
 * one subscription — subscribing twice to the same source would be a leak the
 * caller cannot see.
 * -------------------------------------------------------------------------- */

describe('session current: which source to follow', () => {
  it('follows the observable the winning read answered from', () => {
    const adapter = viewOf('session-1')
    const alias = viewOf('session-1')
    const sessions = sessionsOf({ 'session-1': retained('one') }, 'session-1')

    assert.equal(
      currentSessionObservable({ uiSession: { adapter: { current: adapter } }, sessions }, 0),
      adapter,
    )
    assert.equal(currentSessionObservable({ uiSession: { current: alias } }, 1), alias)
    // Reads 2 and 3 answer from one source, so they name one observable.
    assert.equal(currentSessionObservable({ sessions }, 2), sessions.list)
    assert.equal(currentSessionObservable({ sessions }, 3), sessions.list)
  })

  it('has nothing to follow when no read answered', () => {
    assert.equal(
      currentSessionObservable({ uiSession: {}, sessions: sessionsOf({}) }, -1),
      null,
    )
  })

  it('has nothing to follow when the source is missing or unreadable', () => {
    const sessions = sessionsOf({ 'session-1': retained('one') }, 'session-1')
    // A service that exists but is not an observable.
    assert.equal(currentSessionObservable({ uiSession: { adapter: { current: {} } } }, 0), null)
    assert.equal(currentSessionObservable({}, 1), null)
    assert.equal(currentSessionObservable({}, 2), null)
    // A read that blows up while being reached costs the subscription, not the
    // page: the caller keeps working through the generation check.
    const exploding = {
      get adapter(): never { throw new Error('service is not ready') },
    }
    assert.equal(currentSessionObservable({ uiSession: exploding }, 0), null)
    // ...and the source the other reads use is unaffected.
    assert.equal(currentSessionObservable({ uiSession: exploding, sessions }, 2), sessions.list)
  })
})
