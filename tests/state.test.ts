/**
 * State-machine tests.
 *
 * These cover the orderings that make run-completion detection hard, which is
 * why the store takes an explicit clock instead of reading one: every awkward
 * interleaving can be arranged exactly.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NoticeStore as NoticeStoreType } from '../src/index.js'
import { bridge } from './harness.js'

const { NoticeStore, buildEvent } = bridge

/** A store with generous, easily-reasoned-about bounds. */
function makeStore(
  overrides: Partial<{ maxNotices: number, noticeTtlMs: number, idleGraceMs: number }> = {},
): NoticeStoreType {
  return new NoticeStore({
    maxNotices: overrides.maxNotices ?? 100,
    noticeTtlMs: overrides.noticeTtlMs ?? 24 * 60 * 60 * 1000,
    idleGraceMs: overrides.idleGraceMs ?? 1500,
  })
}

describe('NoticeStore: run lifecycle', () => {
  it('produces exactly one completion for a single-turn run', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)
    assert.deepEqual(store.recordTurnEnd('s1', 1, 'completed', 1_100).completions, [])

    const idle = store.recordIdle('s1', 1_200)
    assert.equal(idle.completions.length, 1)
    assert.equal(idle.completions[0]?.reason, 'completed')
    assert.equal(idle.completions[0]?.targetTurnRef, '1')

    // A second idle for the same run must not produce a second notice.
    assert.deepEqual(store.recordIdle('s1', 1_300).completions, [])
  })

  it('produces exactly one completion for a run that spans several turns', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)
    store.recordTurnEnd('s1', 1, 'completed', 1_100)
    // The loop continues: another turn opens before idle is observed.
    store.startRun('s1', 'run-2', 1_200)
    store.recordTurnEnd('s1', 2, 'completed', 1_300)

    const idle = store.recordIdle('s1', 1_400)
    assert.equal(idle.completions.length, 1)
    assert.equal(idle.completions[0]?.runId, 'run-2')
    assert.equal(idle.completions[0]?.targetTurnRef, '2')
  })

  it('does not report an aborted run as completed', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)
    store.recordTurnEnd('s1', 1, 'aborted', 1_100)
    const idle = store.recordIdle('s1', 1_200)
    assert.equal(idle.completions.length, 1)
    // The *reason* is what the pet labels with; a cancellation is delivered as
    // an abort, never as a normal completion.
    assert.equal(idle.completions[0]?.reason, 'aborted')
  })

  it('keeps a max-tokens ending distinguishable from a normal completion', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)
    store.recordTurnEnd('s1', 1, 'max-tokens', 1_100)
    assert.equal(store.recordIdle('s1', 1_200).completions[0]?.reason, 'max-tokens')
  })

  it('waits out the grace window when idle arrives before turn/end', () => {
    const store = makeStore({ idleGraceMs: 1500 })
    store.startRun('s1', 'run-1', 1_000)

    assert.deepEqual(store.recordIdle('s1', 1_100).completions, [])
    // Nothing yet: the reason is still in flight.
    assert.deepEqual(store.consumeTime(2_000).completions, [])
    // The late turn/end settles it immediately instead of waiting for grace.
    const settled = store.recordTurnEnd('s1', 7, 'completed', 2_100)
    assert.equal(settled.completions.length, 1)
    assert.equal(settled.completions[0]?.targetTurnRef, '7')
  })

  it('settles through the grace timer when idle precedes a late turn/end', () => {
    const store = makeStore({ idleGraceMs: 1_000 })
    store.startRun('s1', 'run-1', 1_000)
    assert.deepEqual(store.recordIdle('s1', 1_100).completions, [])
    // Grace elapses with no reason on record: the run is retired unreported.
    assert.deepEqual(store.consumeTime(2_500).completions, [])
    // The reason arrives after grace and must not resurrect the retired run.
    assert.deepEqual(store.recordTurnEnd('s1', 3, 'completed', 2_600).completions, [])
    assert.deepEqual(store.consumeTime(9_000).completions, [])
  })

  it('does not double-report when the reason lands just inside grace', () => {
    const store = makeStore({ idleGraceMs: 1_000 })
    store.startRun('s1', 'run-1', 1_000)
    assert.deepEqual(store.recordIdle('s1', 1_100).completions, [])
    const settled = store.recordTurnEnd('s1', 5, 'completed', 1_900)
    assert.equal(settled.completions.length, 1)
    assert.deepEqual(store.consumeTime(5_000).completions, [])
  })

  it('never invents a completion when no reason was ever recorded', () => {
    const store = makeStore({ idleGraceMs: 500 })
    store.startRun('s1', 'run-1', 1_000)
    assert.deepEqual(store.recordIdle('s1', 1_100).completions, [])
    // Grace expires with no turn/end: the store stops waiting and produces
    // nothing. A fabricated "your task finished" is worse than silence.
    assert.deepEqual(store.consumeTime(2_000).completions, [])
    assert.deepEqual(store.pendingFor('s1'), [])
  })
})

describe('NoticeStore: parallel sessions', () => {
  it('buckets runs per session instead of keeping one global state', () => {
    const store = makeStore()
    store.startRun('s1', 'run-a', 1_000)
    store.startRun('s2', 'run-b', 1_010)

    // s2 finishes while s1 keeps working.
    store.recordTurnEnd('s2', 1, 'completed', 1_100)
    const done = store.recordIdle('s2', 1_200)
    assert.equal(done.completions.length, 1)
    assert.equal(done.completions[0]?.sessionId, 's2')

    // s1 is untouched: no completion, still running.
    const rows = store.progressSnapshot()
    const s1 = rows.find(row => row.sessionId === 's1')
    assert.equal(s1?.running, true)
    assert.equal(store.pendingFor('s1').length, 0)
  })

  it('drops subagent sessions from the pet view', () => {
    const store = makeStore()
    store.startRun('sub', 'run-sub', 1_000, { subagent: true })
    store.startRun('root', 'run-root', 1_010)
    const ids = store.progressSnapshot().map(row => row.sessionId)
    assert.deepEqual(ids, ['root'])
  })

  it('removes a session from the view without calling it a subagent', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)
    assert.equal(store.removeSession('s1', 1_100), true)
    assert.deepEqual(store.progressSnapshot(), [])
    // The bucket survives for bookkeeping, but it is not reported as a root run.
    assert.equal(store.removeSession('missing', 1_200), false)
  })

  it('carries the reported session read without inventing one', () => {
    const store = makeStore()
    store.startRun('s1', 'run-1', 1_000)

    // No page has reported: the field is *absent*, which is a different claim
    // from a page that looked and found nothing.
    assert.equal(Object.hasOwn(store.progressSnapshot()[0] ?? {}, 'reader'), false)

    store.recordSessionFacts('s1', { reader: 0 }, 1_100)
    assert.equal(store.progressSnapshot()[0]?.reader, 0)

    // A later report naming a fallback read replaces the answer...
    store.recordSessionFacts('s1', { reader: 3 }, 1_200)
    assert.equal(store.progressSnapshot()[0]?.reader, 3)

    // ...while facts that say nothing about the read leave it alone.
    store.recordSessionFacts('s1', { title: 'renamed' }, 1_300)
    assert.equal(store.progressSnapshot()[0]?.reader, 3)
    assert.equal(store.progressSnapshot()[0]?.title, 'renamed')
  })
})

describe('NoticeStore: notice lifecycle', () => {
  const completion = {
    sessionId: 's1',
    runId: 'run-1',
    reason: 'completed' as const,
    targetTurnRef: '4',
    completedAt: 2_000,
  }

  it('accepts an observation only for the matching notice triple', () => {
    const store = makeStore()
    store.createNotice(completion, 'n1', 2_000)

    assert.equal(store.applyObservation({ noticeId: 'n1', runId: 'other', sessionId: 's1' }, 2_100).reason, 'run-mismatch')
    assert.equal(store.applyObservation({ noticeId: 'n1', runId: 'run-1', sessionId: 's2' }, 2_100).reason, 'session-mismatch')
    assert.equal(store.applyObservation({ noticeId: 'nope', runId: 'run-1', sessionId: 's1' }, 2_100).reason, 'unknown-notice')

    const accepted = store.applyObservation({ noticeId: 'n1', runId: 'run-1', sessionId: 's1' }, 2_200)
    assert.equal(accepted.accepted, true)
    assert.equal(store.notice('n1')?.state, 'seen')
    assert.equal(store.notice('n1')?.seenAt, 2_200)
    // Once seen it is no longer offered to the page.
    assert.deepEqual(store.pendingFor('s1'), [])
  })

  it('does not let a late observation resurrect a dismissed notice', () => {
    const store = makeStore()
    store.createNotice(completion, 'n1', 2_000)
    assert.equal(store.applyAck('n1', 'dismissed'), 'dismissed')
    const late = store.applyObservation({ noticeId: 'n1', runId: 'run-1', sessionId: 's1' }, 2_300)
    assert.equal(late.accepted, false)
    assert.equal(late.reason, 'already-dismissed')
    assert.equal(store.notice('n1')?.state, 'dismissed')
  })

  it('is idempotent for repeated and out-of-order acks', () => {
    const store = makeStore()
    store.createNotice(completion, 'n1', 2_000)
    assert.equal(store.applyAck('n1', 'shown'), 'shown')
    assert.equal(store.applyAck('n1', 'shown'), 'shown')
    assert.equal(store.applyAck('n1', 'dismissed'), 'dismissed')
    // A duplicate `shown` after dismissal must not reopen the popup.
    assert.equal(store.applyAck('n1', 'shown'), 'dismissed')
    assert.equal(store.applyAck('unknown', 'shown'), null)
  })

  it('records a delivery advertised as seen', () => {
    const store = makeStore()
    store.createNotice(completion, 'n1', 2_000)
    const delivered = store.markDelivered('n1', true, 2_500)
    assert.equal(delivered?.delivered, true)
    assert.equal(delivered?.state, 'seen')
    assert.equal(store.markDelivered('missing', true, 2_500), null)
  })

  it('offers both pending and shown notices to the page, and only those', () => {
    const store = makeStore()
    store.createNotice(completion, 'n1', 2_000)
    store.createNotice({ ...completion, runId: 'run-2', completedAt: 2_100 }, 'n2', 2_100)
    store.createNotice({ ...completion, runId: 'run-3', completedAt: 2_200 }, 'n3', 2_200)
    store.createNotice({ ...completion, runId: 'run-4', completedAt: 2_300 }, 'n4', 2_300)

    // The pet displayed n1: it must stay visible to the page, or the user
    // reading that result could never have the popup retracted.
    store.applyAck('n1', 'shown')
    store.applyAck('n3', 'dismissed')
    store.applyObservation({ noticeId: 'n4', runId: 'run-4', sessionId: 's1' }, 2_400)

    assert.deepEqual(store.pendingFor('s1').map(notice => notice.noticeId), ['n1', 'n2'])
    assert.equal(store.pendingFor('s1')[0]?.state, 'shown')
    assert.equal(store.pendingFor('s1')[1]?.state, 'pending')
  })

  it('expires settled notices by age but never by age alone while open', () => {
    const store = makeStore({ noticeTtlMs: 1_000 })
    store.createNotice(completion, 'open', 1_000)
    store.createNotice({ ...completion, runId: 'run-2' }, 'closed', 1_000)
    store.applyAck('closed', 'dismissed')

    store.consumeTime(5_000)
    assert.equal(store.notice('open')?.noticeId, 'open')
    assert.equal(store.notice('closed'), null)
  })

  it('trims settled notices down to the retention cap', () => {
    const store = makeStore({ maxNotices: 2 })
    for (let index = 0; index < 5; index += 1) {
      const id = `n${index}`
      store.createNotice({ ...completion, runId: `run-${index}`, completedAt: 1_000 + index }, id, 1_000 + index)
      store.applyAck(id, 'dismissed')
    }
    assert.equal(store.allNotices().length, 2)
  })
})

describe('buildEvent: the privacy boundary', () => {
  it('carries only identifiers, counts, and bounded labels', () => {
    const event = buildEvent({
      id: 'e1',
      event: 'completed',
      hook: 'run/idle',
      sessionId: 's1',
      runId: 'run-1',
      targetTurnRef: '9',
      at: 1_700_000_000_000,
      title: 'a title',
      message: 'done',
      reason: 'completed',
      seen: false,
      noticeId: 'n1',
    })
    assert.deepEqual(Object.keys(event).sort(), [
      'event', 'hook', 'id', 'message', 'noticeId', 'reason', 'runId',
      'seen', 'sessionId', 'source', 'targetTurnRef', 'timestamp', 'title', 'v',
    ])
  })

  it('clamps a title that would otherwise carry a prompt fragment', () => {
    const long = 'x'.repeat(500)
    const event = buildEvent({
      id: 'e1',
      event: 'running',
      hook: 'turn/start',
      sessionId: 's1',
      at: 1,
      title: long,
    })
    assert.equal(event.title?.length, 160)
    assert.equal(event.title?.endsWith('...'), true)
  })

  it('omits absent optional fields instead of sending null placeholders', () => {
    const event = buildEvent({
      id: 'e1',
      event: 'idle',
      hook: 'plugin/start',
      sessionId: 'host',
      at: 1,
    })
    assert.equal('message' in event, false)
    assert.equal('tool' in event, false)
    assert.equal('reason' in event, false)
    assert.equal('seen' in event, false)
    assert.equal('noticeId' in event, false)
    assert.equal(event.title, null)
  })
})
