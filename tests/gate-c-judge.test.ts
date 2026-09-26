/**
 * Gate C verdict rules.
 *
 * The driver can only *sequence* Gate C: which tab is in front, whether focus
 * emulation is on, and when a popup is closed are all CDP-side decisions. The
 * verdicts therefore live in `tools/gate-c-judge.js`, fed with the raw
 * observations, and this file is where they are held to account. Two failure
 * modes are the reason it exists at all:
 *
 * 1. **A phase that was never built must not read as a product failure.** If the
 *    window was still focused when the phase needed it blurred, or the reply was
 *    not on screen when the phase needed it visible, the honest verdict is
 *    `INCONCLUSIVE`. ROUND 7's second live run wrote "the scenario could not be
 *    built" down as `FAIL` and the plan forbids exactly that.
 * 2. **A phase that was built must not pass on a partial observation.** A page
 *    that posts `/seen` while it is supposed to be unobserved is a `FAIL` even if
 *    the host refused it; a notice that leaves the offer without this tab's report
 *    is `INCONCLUSIVE`, not a pass.
 *
 * The judge is DOM-free, so it is evaluated here the same way the driver
 * evaluates it in the browser: the file's own text, in a plain context.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Path of the judge under test, from the compiled test's own location. */
const JUDGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'gate-c-judge.js',
)

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIP'

interface Check {
  readonly id: string
  readonly verdict: Verdict
  readonly detail: string
}

interface JudgeHandle {
  readonly version: string
  readonly judge: (observations: unknown) => Check[]
}

/** One post the page made, as the driver records it. */
interface Post {
  readonly status: number | null
  readonly accepted: boolean | null
  readonly body?: string
}

/** The parts of a phase a test cares about; the rest is filled in below. */
interface PhaseSpec {
  readonly kind?: string
  readonly id?: string
  readonly title?: string
  readonly holdMs?: number
  readonly heldMs?: number
  readonly settledEarly?: boolean
  readonly timeline?: Record<string, unknown>
  readonly dwellMs?: number
  readonly expect?: Record<string, unknown>
  readonly measured?: Record<string, unknown>
  readonly seenAfter?: readonly Post[]
  readonly hostBefore?: Record<string, unknown>
  readonly hostAfter?: Record<string, unknown>
  readonly alsoUnchanged?: ReadonlyArray<{ noticeId: string; offered: boolean }>
  readonly scoping?: Record<string, unknown>
}

const NOTICE_ID = 'notice-gate-c'

/** Load the judge the way the browser does: its own text, no imports. */
function loadJudge(): JudgeHandle {
  const source = readFileSync(JUDGE_PATH, 'utf8')
  const fake: Record<string, unknown> = {}
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', source)(fake, fake)
  const handle = fake.__petGateCJudge as JudgeHandle | undefined
  assert.ok(handle !== undefined, 'the judge published window.__petGateCJudge')
  return handle
}

/** Judge one phase, with the boring fields defaulted. */
function verdictFor(spec: PhaseSpec): Check {
  const judge = loadJudge()
  const checks = judge.judge({
    target: { noticeId: NOTICE_ID, runId: 'run-1', sessionId: 'session-b', targetTurnRef: '3' },
    dwellMs: spec.dwellMs ?? 1_500,
    phases: [{
      id: spec.id ?? 'C-test',
      title: spec.title ?? 'a phase',
      kind: spec.kind ?? 'negative',
      holdMs: spec.holdMs ?? 6_000,
      ...(spec.heldMs === undefined ? {} : { heldMs: spec.heldMs }),
      ...(spec.settledEarly === undefined ? {} : { settledEarly: spec.settledEarly }),
      ...(spec.timeline === undefined ? {} : { timeline: spec.timeline }),
      target: { noticeId: NOTICE_ID },
      expect: spec.expect ?? {},
      measured: {
        pageVisible: 'hidden',
        pageFocused: false,
        replyOnBand: true,
        replyOffBand: false,
        groupOverlap: 705,
        ...(spec.measured ?? {}),
      },
      seenBefore: 0,
      seenAfter: spec.seenAfter ?? [],
      hostBefore: { state: 'pending', seenAt: null, ...(spec.hostBefore ?? {}) },
      hostAfter: { state: 'pending', seenAt: null, offered: true, ...(spec.hostAfter ?? {}) },
      scoping: spec.scoping ?? { otherSessionOfferNoticeIds: [] },
      alsoUnchanged: spec.alsoUnchanged ?? [],
    }],
  })
  assert.equal(checks.length, 1, 'one phase produces one check')
  return checks[0] as Check
}

/** A post that the host accepted, for the positive phases. */
const acceptedPost = (): Post => ({ status: 200, accepted: true, body: `{"noticeId":"${NOTICE_ID}"}` })

describe('gate C verdicts', () => {
  it('publishes a version, so a report can name the rules it was judged by', () => {
    assert.match(loadJudge().version, /^gate-c-judge-\d+$/)
  })

  describe('a phase that must not confirm anything', () => {
    it('passes when the page was really unobserved, nothing was reported and the host did not move', () => {
      const check = verdictFor({})
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /new \/seen=0/)
      assert.match(check.detail, /hidden/)
    })

    it('fails when the page reported the notice it was not supposed to observe', () => {
      const check = verdictFor({ seenAfter: [{ status: 200, accepted: true }] })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /posted \/seen/)
    })

    it('is inconclusive when the notice stopped being offered before the phase could read it', () => {
      const check = verdictFor({ hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /stopped being offered/)
    })

    it('fails when the host marked the notice seen although this tab never reported it', () => {
      const check = verdictFor({ hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: true } })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /never reported it/)
    })

    it('does not read a popup appearing or being closed as an observation', () => {
      const shown = verdictFor({ hostAfter: { state: 'shown', seenAt: null, offered: true } })
      assert.equal(shown.verdict, 'PASS')
      const closed = verdictFor({
        hostAfter: { state: 'dismissed', seenAt: null, offered: false },
      })
      assert.equal(closed.verdict, 'INCONCLUSIVE')
      assert.match(closed.detail, /stopped being offered/)
    })

    it('is inconclusive, never a pass, when the blur the phase needs was never established', () => {
      const check = verdictFor({
        expect: { visible: 'visible', focused: false },
        measured: { pageVisible: 'visible', pageFocused: true },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /still reported focus/)
    })

    it('is inconclusive when the tab turned out to be in the wrong visibility state', () => {
      const check = verdictFor({
        expect: { visible: 'hidden' },
        measured: { pageVisible: 'visible', pageFocused: false },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /did not exercise the state/)
    })

    it('is inconclusive when the reply was not on screen, so nothing was being "not observed"', () => {
      const check = verdictFor({
        expect: { replyOnBand: true },
        measured: { replyOnBand: false, replyOffBand: true, groupOverlap: -16 },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /not on screen during the hold/)
      assert.match(check.detail, /-16/)
    })

    it('is inconclusive when the counterexample geometry was lost during the hold', () => {
      const check = verdictFor({
        expect: { replyOffBand: true },
        measured: { replyOnBand: true, replyOffBand: false, groupOverlap: 120 },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /was not strictly off the band/)
    })

    it('fails when the other session\'s page was offered this notice', () => {
      const check = verdictFor({ scoping: { otherSessionOfferNoticeIds: [NOTICE_ID] } })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /leaked across sessions/)
    })

    it('is inconclusive when no other turn was on screen, so no mismatch was built', () => {
      const check = verdictFor({
        expect: { visible: 'visible', focused: true, otherTurnOnBand: true },
        measured: { pageVisible: 'visible', pageFocused: true, otherTurnOnBand: false },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /no other turn's reply was on screen/)
    })

    it('is inconclusive when the page was watching another notice, not the one judged', () => {
      const check = verdictFor({
        expect: { watched: true },
        measured: { watchPredictedNoticeId: 'some-other-notice', watchPredictedTurn: 7 },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /would have watched some-other-notice/)
      assert.match(check.detail, /nothing about this notice was measured/)
    })

    it('is inconclusive for a "must watch this" negative when the page watched something else', () => {
      const check = verdictFor({
        expect: { watched: true },
        measured: { watchPredictedNoticeId: 'older-notice', watchPredictedTurn: 4 },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /would have watched older-notice/)
    })

    it('passes a "must watch this" negative when the mirror agrees', () => {
      const check = verdictFor({
        expect: { watched: true },
        measured: { watchPredictedNoticeId: NOTICE_ID, watchPredictedTurn: 3, watchPredictedVisible: true },
      })
      assert.equal(check.verdict, 'PASS')
    })

    it('is inconclusive for a mismatch when the page was watching the judged notice on screen', () => {
      const check = verdictFor({
        expect: { watched: false },
        measured: { watchPredictedNoticeId: NOTICE_ID, watchPredictedTurn: 3, watchPredictedVisible: true },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /never built/)
    })

    it('still runs a mismatch when the judged notice is only the un-dwelt fallback candidate', () => {
      const check = verdictFor({
        expect: { watched: false, otherTurnOnBand: true },
        measured: {
          watchPredictedNoticeId: NOTICE_ID,
          watchPredictedTurn: 3,
          watchPredictedVisible: false,
          otherTurnOnBand: true,
          replyOffBand: true,
          replyOnBand: false,
        },
      })
      assert.equal(check.verdict, 'PASS')
    })

    it('passes a mismatch when the page was watching a different notice', () => {
      const check = verdictFor({
        expect: { watched: false, otherTurnOnBand: true },
        measured: {
          watchPredictedNoticeId: 'other-notice',
          watchPredictedTurn: 4,
          otherTurnOnBand: true,
          replyOffBand: true,
          replyOnBand: false,
        },
      })
      assert.equal(check.verdict, 'PASS')
    })
  })

  describe('a phase that must confirm', () => {
    const positive = (spec: PhaseSpec): Check => verdictFor({
      kind: 'positive',
      expect: { visible: 'visible', focused: true, replyOnBand: true },
      ...spec,
      measured: {
        pageVisible: 'visible',
        pageFocused: true,
        replyOnBand: true,
        replyOffBand: false,
        ...(spec.measured ?? {}),
      },
    })

    it('passes on a report the host accepted and a notice that left the offer', () => {
      const check = positive({
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
      })
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /new \/seen posts=1/)
      assert.match(check.detail, /no longer offered/)
    })

    /*
     * A positive phase stops as soon as its notice is confirmed, so `holdMs` is
     * the ceiling it was given, not the time it held. The round-7 report quoted
     * the ceiling — "inside the band for 2700 ms" for phases that settled after
     * 326 ms and 647 ms — which read as far stronger evidence than it was.
     */
    it('reports the measured hold, not the window it was allowed', () => {
      const check = positive({
        holdMs: 2_700,
        heldMs: 326,
        settledEarly: true,
        timeline: { prepareMs: 2_100, seenAfterHoldStartMs: 326, seenUpperBoundMs: 2_426 },
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
      })
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /for 326 ms of the 2700 ms window/)
      assert.match(check.detail, /ended on confirmation/)
      assert.doesNotMatch(check.detail, /for 2700 ms/)
      // The dwell the client satisfies is continuous visible *and focused* time,
      // so the phase must not imply it watched a full dwell of its own.
      assert.match(check.detail, /confirmed 326 ms into the hold/)
      assert.match(check.detail, /at most 2426 ms after staging began/)
      assert.match(check.detail, /under the 1500 ms the client requires/)
    })

    it('does not name a window when the hold ran to completion', () => {
      const check = positive({
        holdMs: 6_000,
        heldMs: 6_004,
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
      })
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /for 6004 ms/)
      assert.doesNotMatch(check.detail, /of the 6000 ms window/)
    })

    it('fails when the host refused the report', () => {
      const check = positive({ seenAfter: [{ status: 500, accepted: null }], hostAfter: { offered: false } })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /refused it: HTTP 500/)
    })

    it('fails when the host accepted the request but threw the observation away', () => {
      const check = positive({ seenAfter: [{ status: 200, accepted: false }], hostAfter: { offered: false } })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /accepted=false/)
    })

    it('fails when the page reported but the notice is still on offer', () => {
      const check = positive({ seenAfter: [acceptedPost()] })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /still offered/)
    })

    it('fails when the page never reported although it was focused and looking at the reply', () => {
      const check = positive({})
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /new \/seen posts=0/)
    })

    it('is inconclusive when the notice was retired by somebody else', () => {
      const check = positive({ hostAfter: { state: 'seen', seenAt: 1, offered: false } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /another consumer/)
    })

    it('is inconclusive when the reply was not inside the band', () => {
      const check = positive({ measured: { replyOnBand: false, replyOffBand: true, groupOverlap: -16 } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /nothing to observe/)
    })

    it('is inconclusive when the page was not focused, rather than blaming the product', () => {
      const check = positive({ measured: { pageFocused: false } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /could not run/)
    })

    it('fails when confirming one notice also retired the notice for another turn', () => {
      const check = positive({
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
        alsoUnchanged: [{ noticeId: 'older-notice', offered: false }],
      })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /also retired older-notice/)
    })

    it('passes and says so when the older notice stayed on offer', () => {
      const check = positive({
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
        alsoUnchanged: [{ noticeId: 'older-notice', offered: true }],
      })
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /older-notice stayed offered/)
    })

    it('is inconclusive when the page was watching an older notice instead', () => {
      const check = positive({
        measured: { watchPredictedNoticeId: 'older-notice', watchPredictedTurn: 4 },
      })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /would have watched older-notice/)
    })

    it('is inconclusive when the offer had no visible candidate at all', () => {
      const check = positive({ measured: { watchPredictedNoticeId: null, watchPredictedVisible: false } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /no visible candidate/)
    })

    it('still passes when the mirror agrees with the target', () => {
      const check = positive({
        seenAfter: [acceptedPost()],
        hostBefore: { state: 'shown' },
        hostAfter: { state: 'seen', seenAt: 1_700_000_000_000, offered: false },
        measured: { watchPredictedNoticeId: NOTICE_ID, watchPredictedTurn: 3, watchPredictedVisible: true },
      })
      assert.equal(check.verdict, 'PASS')
    })
  })

  describe('a popup the user closed', () => {
    const dismissed = (spec: PhaseSpec): Check => verdictFor({
      kind: 'dismissed',
      expect: { visible: 'visible', focused: true, replyOnBand: true },
      ...spec,
      measured: {
        pageVisible: 'visible',
        pageFocused: true,
        replyOnBand: true,
        ...(spec.measured ?? {}),
      },
      hostBefore: { state: 'shown', ...(spec.hostBefore ?? {}) },
      hostAfter: { state: 'dismissed', seenAt: null, offered: false, rebuilt: null, ...(spec.hostAfter ?? {}) },
    })

    it('passes when nothing happens after the user closed it', () => {
      const check = dismissed({})
      assert.equal(check.verdict, 'PASS')
      assert.match(check.detail, /no \/seen, still not offered/)
      assert.match(check.detail, /see the pet log/)
    })

    it('fails when the page reports a notice the user already closed', () => {
      const check = dismissed({ seenAfter: [{ status: 200, accepted: false }] })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /already closed/)
    })

    it('fails when the popup was pushed to the pet again', () => {
      const check = dismissed({ hostAfter: { state: 'dismissed', seenAt: null, offered: false, rebuilt: true } })
      assert.equal(check.verdict, 'FAIL')
      assert.match(check.detail, /pushed to the pet again/)
    })

    it('is inconclusive when the manual close never took effect', () => {
      const check = dismissed({ hostAfter: { state: 'shown', seenAt: null, offered: true, rebuilt: null } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /never established/)
    })

    it('is inconclusive when the reply never came back into the band', () => {
      const check = dismissed({ measured: { replyOnBand: false, replyOffBand: true, groupOverlap: -40 } })
      assert.equal(check.verdict, 'INCONCLUSIVE')
      assert.match(check.detail, /never looked at the/)
    })
  })

  it('records a phase it does not know as a skip rather than guessing a verdict', () => {
    const check = verdictFor({ kind: 'something-new' })
    assert.equal(check.verdict, 'SKIP')
    assert.match(check.detail, /unknown phase kind/)
  })
})
