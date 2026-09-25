/**
 * Tests for the page half's decisions.
 *
 * These call the shipping logic in `src/client/decide.ts` directly. The three
 * defects of this round live here: picking a watch target that is not blocked
 * by an off-screen older notice (D3), treating a transient refusal as
 * retryable rather than as a lifetime ban (D4), and accepting the host's dwell
 * threshold (D5).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TERMINAL_SEEN_REASONS,
  classifySeenOutcome,
  createAttemptGate,
  resolveDwellMs,
  selectWatchTarget,
  turnOf,
  watchableCandidates,
} from '../src/client/decide.js'
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
