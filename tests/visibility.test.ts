/**
 * Visibility judgement tests.
 *
 * The subject is `src/client/visibility.ts` as it ships. The cases are the ones
 * D1 was found through, in particular the shapes that made the old
 * "measure the first `[data-chat-turn]` match" rule fail on a real page:
 *
 * - the turn header on screen while the answer is not (must not count);
 * - the answer on screen while the header is not (must count);
 * - several items carrying the same turn number;
 * - zero-height virtualisation placeholders;
 * - a turn number that is not rendered at all.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  VisibilityTracker,
  flowItems,
  isTurnVisible,
  kindOf,
  turnNumberOf,
  turnResultBox,
} from '../src/client/visibility.js'
import { FixtureDocument, item, notice } from './client-fixture.js'

/** A fresh page showing a 1200 px viewport. */
function makeScene(): FixtureDocument {
  return new FixtureDocument()
}

describe('flow item attributes', () => {
  it('reads the turn number and kind off an item', () => {
    assert.equal(turnNumberOf(item(7, 'assistant-step')), 7)
    assert.equal(kindOf(item(7, 'assistant-step')), 'assistant-step')
  })

  it('rejects a turn attribute that is not a usable number', () => {
    const missing = item(1, 'assistant-step')
    assert.equal(turnNumberOf(missing), 1)
    assert.equal(turnNumberOf({ getAttribute: () => null }), null)
    assert.equal(turnNumberOf({ getAttribute: () => 'turn-3' }), null)
    assert.equal(turnNumberOf({ getAttribute: () => '-1' }), null)
    assert.equal(turnNumberOf({ getAttribute: () => '1.5' }), null)
    assert.equal(turnNumberOf(null), null)
  })

  it('ignores nodes that cannot be measured', () => {
    const scene = makeScene()
    scene.setItems([item(1, 'assistant-step', { top: 100, bottom: 400 })])
    assert.equal(flowItems(scene.deps()).length, 1)
  })
})

describe('D1: which element stands for the result', () => {
  it('uses the answer item, not the turn header', () => {
    const scene = makeScene()
    // The header is a small row near the top of the turn; the answer is far
    // below it. Only the header is on screen.
    scene.setItems([
      item(3, 'user', { top: 100, bottom: 300 }),
      item(3, 'assistant-step', { top: 3_000, bottom: 6_000 }),
    ])
    const box = turnResultBox(scene.deps(), 3)
    assert.equal(box?.top, 3_000)
    assert.equal(box?.bottom, 6_000)
    // The user cannot see the answer yet, so this turn must not be reported.
    assert.equal(isTurnVisible(scene.deps(), 3), false)
  })

  it('counts a turn whose answer is on screen but whose header is not', () => {
    const scene = makeScene()
    scene.setItems([
      item(3, 'user', { top: -8_000, bottom: -7_700 }),
      item(3, 'assistant-step', { top: 300, bottom: 2_000 }),
    ])
    assert.equal(isTurnVisible(scene.deps(), 3), true)
  })

  it('measures every answer item of one turn together', () => {
    const scene = makeScene()
    // With the process disclosure open, a long turn renders one answer item per
    // step. The user reading step 2 is looking at this turn's result.
    scene.setItems([
      item(4, 'user', { top: -9_000, bottom: -8_800 }),
      item(4, 'assistant-step', { top: -5_000, bottom: -3_000 }),
      item(4, 'assistant-step', { top: 200, bottom: 1_500 }),
      item(4, 'turn-tail', { top: 1_510, bottom: 1_540 }),
    ])
    assert.equal(isTurnVisible(scene.deps(), 4), true)
    const box = turnResultBox(scene.deps(), 4)
    assert.equal(box?.top, -5_000)
    assert.equal(box?.bottom, 1_500)
  })

  it('falls back to the failure item when a turn produced no answer', () => {
    const scene = makeScene()
    scene.setItems([
      item(5, 'user', { top: -9_000, bottom: -8_800 }),
      item(5, 'turn-error', { top: 400, bottom: 700 }),
    ])
    const box = turnResultBox(scene.deps(), 5)
    assert.equal(box?.top, 400)
    assert.equal(isTurnVisible(scene.deps(), 5), true)
  })

  it('reports nothing when no result kind rendered', () => {
    const scene = makeScene()
    /*
     * Prompt and process rows only. Unioning every item of the turn used to make
     * this turn count as seen — the user was looking at their own message or at
     * a tool row, and the notice was retired anyway. Nothing here is a result,
     * so the turn is not observed at all.
     */
    scene.setItems([
      item(6, 'user', { top: 100, bottom: 300 }),
      item(6, 'tool-call', { top: 320, bottom: 900 }),
    ])
    assert.equal(turnResultBox(scene.deps(), 6), null)
    assert.equal(isTurnVisible(scene.deps(), 6), false)
  })

  it('still credits a failure item when the turn rendered no answer', () => {
    const scene = makeScene()
    // The no-result rule must not swallow the terminal notices: an error or a
    // max-tokens stop *is* what this turn has to say.
    scene.setItems([
      item(6, 'user', { top: -9_000, bottom: -8_800 }),
      item(6, 'reasoning', { top: 100, bottom: 320 }),
      item(6, 'turn-max-tokens', { top: 400, bottom: 700 }),
    ])
    const box = turnResultBox(scene.deps(), 6)
    assert.equal(box?.top, 400)
    assert.equal(box?.bottom, 700)
    assert.equal(isTurnVisible(scene.deps(), 6), true)
  })

  it('skips zero-height placeholders and collapsed answers', () => {
    const scene = makeScene()
    scene.setItems([
      item(7, 'user', { top: 0, bottom: 0, height: 0 }),
      item(7, 'assistant-step', { top: 0, bottom: 0, height: 0 }),
    ])
    assert.equal(turnResultBox(scene.deps(), 7), null)
    assert.equal(isTurnVisible(scene.deps(), 7), false)
  })

  it('does not confuse two turns sharing a header shape', () => {
    const scene = makeScene()
    scene.setItems([
      item(8, 'user', { top: -9_000, bottom: -8_800 }),
      item(8, 'assistant-step', { top: -8_000, bottom: -6_000 }),
      item(9, 'user', { top: 100, bottom: 300 }),
      item(9, 'assistant-step', { top: 5_000, bottom: 9_000 }),
    ])
    assert.equal(isTurnVisible(scene.deps(), 8), false)
    assert.equal(isTurnVisible(scene.deps(), 9), false)
  })

  it('reports nothing for a turn that is not rendered', () => {
    const scene = makeScene()
    scene.setItems([item(1, 'assistant-step', { top: 100, bottom: 900 })])
    assert.equal(turnResultBox(scene.deps(), 2), null)
    assert.equal(isTurnVisible(scene.deps(), 2), false)
  })

  it('measures nothing without a flow element', () => {
    const scene = makeScene()
    scene.setItems([item(1, 'assistant-step', { top: 100, bottom: 900 })])
    const deps = { ...scene.deps(), flowElement: null, document: null }
    assert.equal(isTurnVisible(deps, 1), false)
  })

  it('clips the band to the scroll container, not just the viewport', () => {
    const scene = makeScene()
    // The answer sits under the composer: inside the window, outside the
    // scroll container's visible box.
    scene.scroll.setRect({ top: 76, bottom: 1_000 })
    scene.setItems([item(1, 'assistant-step', { top: 1_010, bottom: 3_000 })])
    assert.equal(isTurnVisible(scene.deps(), 1), false)

    scene.setItems([item(1, 'assistant-step', { top: 500, bottom: 3_000 })])
    assert.equal(isTurnVisible(scene.deps(), 1), true)
  })
})

describe('VisibilityTracker: the L1 to L3 ladder', () => {
  const target = { sessionId: 'session-1', noticeId: 'n1', turn: 3 }

  /** A tracker whose clock the test drives. */
  function makeTracker(scene: FixtureDocument, dwellMs: number): {
    tracker: VisibilityTracker
    advance: (ms: number) => void
  } {
    let clock = 10_000
    const tracker = new VisibilityTracker({
      deps: scene.deps(),
      dwellMs,
      now: () => clock,
    })
    return { tracker, advance: (ms) => { clock += ms } }
  }

  it('reports once the result has been on screen for the dwell', () => {
    const scene = makeScene()
    scene.setItems([
      item(3, 'user', { top: -9_000, bottom: -8_800 }),
      item(3, 'assistant-step', { top: 200, bottom: 4_000 }),
    ])
    const { tracker, advance } = makeTracker(scene, 1_500)
    tracker.setTarget(target)

    const doc = { visibilityState: 'visible', hasFocus: () => true } as Document
    assert.equal(tracker.update(doc).report, null)
    advance(1_400)
    assert.equal(tracker.update(doc).report, null)
    advance(200)
    assert.deepEqual(tracker.update(doc).report, { noticeId: 'n1', sessionId: 'session-1' })
    // Once per target, however long the page stays there.
    advance(5_000)
    assert.equal(tracker.update(doc).report, null)
    assert.equal(tracker.update(doc).level, 'observed')
  })

  it('never reports while the answer is off screen', () => {
    const scene = makeScene()
    scene.setItems([
      item(3, 'user', { top: 100, bottom: 300 }),
      item(3, 'assistant-step', { top: 4_000, bottom: 9_000 }),
    ])
    const { tracker, advance } = makeTracker(scene, 1_000)
    tracker.setTarget(target)
    const doc = { visibilityState: 'visible', hasFocus: () => true } as Document
    for (let index = 0; index < 10; index += 1) {
      advance(1_000)
      assert.equal(tracker.update(doc).report, null)
    }
  })

  it('restarts the clock when the answer scrolls away and back', () => {
    const scene = makeScene()
    scene.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    const { tracker, advance } = makeTracker(scene, 1_000)
    tracker.setTarget(target)
    const doc = { visibilityState: 'visible', hasFocus: () => true } as Document

    tracker.update(doc)
    advance(900)
    scene.setItems([item(3, 'assistant-step', { top: 9_000, bottom: 12_000 })])
    assert.equal(tracker.update(doc).report, null)
    scene.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    advance(900)
    // The earlier 900 ms must not count: dwell restarted at this update.
    assert.equal(tracker.update(doc).report, null)
    // 901 ms alone must not satisfy a 1 000 ms threshold.
    advance(901)
    assert.equal(tracker.update(doc).report, null, 'the dwell must have restarted, not resumed')
    advance(99)
    assert.notEqual(tracker.update(doc).report, null)
  })

  it('restarts the clock when the host changes the dwell threshold', () => {
    const scene = makeScene()
    scene.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    const { tracker, advance } = makeTracker(scene, 1_000)
    tracker.setTarget(target)
    const doc = { visibilityState: 'visible', hasFocus: () => true } as Document
    tracker.update(doc)
    advance(900)

    assert.equal(tracker.setDwellMs(2_000), true)
    assert.equal(tracker.currentDwellMs(), 2_000)
    // The next evaluation is what re-baselines the clock under the new value.
    assert.equal(tracker.update(doc).report, null)
    assert.equal(tracker.update(doc).report, null)

    // The 900 ms banked under the 1 000 ms threshold must not count: 1 999 ms
    // under the new threshold is still short of it.
    advance(1_999)
    assert.equal(tracker.update(doc).report, null, 'time banked under the old threshold must not count')
    advance(1)
    assert.notEqual(tracker.update(doc).report, null)
  })

  it('ignores an unusable dwell threshold', () => {
    const scene = makeScene()
    const { tracker } = makeTracker(scene, 1_000)
    assert.equal(tracker.setDwellMs(Number.NaN), false)
    assert.equal(tracker.setDwellMs(-5), false)
    assert.equal(tracker.setDwellMs(1_000), false)
    assert.equal(tracker.currentDwellMs(), 1_000)
  })

  it('breaks dwell when the page loses focus or visibility', () => {
    const scene = makeScene()
    scene.setItems([item(3, 'assistant-step', { top: 200, bottom: 4_000 })])
    const { tracker, advance } = makeTracker(scene, 1_000)
    tracker.setTarget(target)
    const focused = { visibilityState: 'visible', hasFocus: () => true } as Document
    const blurred = { visibilityState: 'visible', hasFocus: () => false } as Document
    const hidden = { visibilityState: 'hidden', hasFocus: () => true } as Document

    tracker.update(focused)
    advance(900)
    assert.equal(tracker.update(blurred).level, 'visible')
    tracker.update(focused)
    advance(900)
    assert.equal(tracker.update(focused).report, null)
    advance(200)
    assert.notEqual(tracker.update(focused).report, null)

    // A hidden tab restarts it too.
    tracker.setTarget(null)
    tracker.setTarget(target)
    tracker.update(hidden)
    tracker.update(focused)
    advance(900)
    assert.equal(tracker.update(focused).report, null)
  })

  it('resets the dwell when the watch target changes', () => {
    const scene = makeScene()
    // Both results are on screen, so only the target change can explain a reset.
    scene.setItems([
      item(3, 'assistant-step', { top: 150, bottom: 300 }),
      item(4, 'assistant-step', { top: 400, bottom: 600 }),
    ])
    const { tracker, advance } = makeTracker(scene, 1_000)
    const doc = { visibilityState: 'visible', hasFocus: () => true } as Document
    tracker.setTarget(target)
    tracker.update(doc)
    advance(900)

    tracker.setTarget({ sessionId: 'session-1', noticeId: 'n2', turn: 4 })
    // The next evaluation re-baselines the clock for the new target; the 900 ms
    // spent on turn 3 must not carry over.
    assert.equal(tracker.update(doc).report, null, 'the new target must start from zero')
    advance(900)
    assert.equal(tracker.update(doc).report, null, "the previous target's 900 ms must not count")
    advance(100)
    assert.deepEqual(tracker.update(doc).report, { noticeId: 'n2', sessionId: 'session-1' })
  })
})

describe('notice helpers', () => {
  it('builds notice fixtures with the shape the host sends', () => {
    const row = notice('n1', 3)
    assert.equal(row.targetTurnRef, '3')
    assert.equal(row.sessionId, 'session-1')
    assert.equal(row.runId, 'run-3')
  })
})
