/**
 * Smoke test for `tools/acceptance-client-page.js`.
 *
 * That runner is a hand-executed artifact: the operator pastes it into a live
 * page, and a crash there costs a whole acceptance round — the failure mode this
 * project keeps hitting. So this test drives the real file, unmodified, against
 * a scroll-aware DOM double, and pins the two properties that make it worth
 * running at all:
 *
 * 1. **It completes.** Session discovery, geometry, both stagings, and the
 *    summary all run end to end without throwing.
 * 2. **Gate A is not self-satisfying.** The runner must report `FAIL` for the
 *    positive case when nothing actually posted `/seen`, and `PASS` only once a
 *    client does. A runner that re-implemented the visibility rule and judged
 *    its own copy could report `PASS` on the very bug it exists to catch.
 * 3. **The counterexample is not self-satisfying either.** `A2` may only `PASS`
 *    for the geometry the plan names — some other row of the turn on screen,
 *    the reply strictly off it — and must `SKIP` when the staging failed, when
 *    the whole turn left the band, or when the reply still overlaps by a
 *    fraction of a pixel (ROUND 3 review, P1).
 *
 * The double is deliberately scroll-aware: the runner stages a turn by writing
 * `scrollTop` and then re-measuring, so a double with static rectangles would
 * silently skip both phases and prove nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Path of the runner under test, from the compiled test's own location. */
const RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'acceptance-client-page.js',
)

/** Top of the scroll container, in viewport coordinates. */
const SCROLL_TOP = 76
/** Bottom of the scroll container; also the viewport height. */
const SCROLL_BOTTOM = 1_279
/** Visible band height, derived once so the layouts below can be reasoned about. */
const BAND_HEIGHT = SCROLL_BOTTOM - SCROLL_TOP
/** Total scrollable content height. */
const CONTENT_HEIGHT = 5_156
const SESSION_ID = 'session-smoke'
const NOTICE_ID = 'notice-smoke'
/** Turn the stubbed notice points at. */
const NOTICE_TURN = 6
/** One rendered conversation-flow item, at an absolute content offset. */
interface ItemSpec {
  readonly turn: number
  readonly kind: string
  readonly absTop: number
  readonly height: number
}

/** Verdicts the runner can emit. */
type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIP' | 'INFO'

interface Check {
  readonly id: string
  readonly verdict: Verdict
  readonly detail: string
}

interface RunnerHandle {
  readonly sessionId?: string
  readonly checks: readonly Check[]
  readonly requests: ReadonlyArray<{
    url: string
    method: string
    body: string | null
    status?: number | null
    accepted?: boolean | null
  }>
  /**
   * The target-selection rule, published by the runner so it can be tested
   * directly. See the dedicated test below for why a page scene is not enough.
   */
  readonly chooseTarget?: (candidates: readonly Candidate[]) => Candidate | undefined
  /**
   * The notice the run was judged against, published so the report can be tied
   * back to one notice: `noticeId`, `runId`, `sessionId`, `targetTurnRef`.
   */
  readonly target?: {
    readonly noticeId: string
    readonly runId: string | null
    readonly sessionId: string | null
    readonly targetTurnRef: string | null
  } | null
}

/** One candidate notice, as the runner assembles them before choosing a target. */
interface Candidate {
  readonly turn: number
  readonly state: { readonly belowFold: { readonly stageable: boolean } | null }
}

/*
 * Two turns, each with a small head row followed by the reply. This is the
 * shape D1 is about: the first `[data-chat-turn]` match is the 78 px head, and
 * the answer is the `assistant-step` after it.
 *
 * The notice turn's reply is deliberately *shorter than the visible band*
 * (500 px against 1 203 px) and the conversation continues below it, so
 * `stageReplyBelowFold()` has an unambiguous target here. Pushing the reply below
 * the band is done by scrolling *up*, so what this layout really needs is a full
 * conversation above the reply — which the earlier turn supplies. That the reply
 * is short is a convenience for the arithmetic in these comments, not a
 * condition: the tall-reply fixtures below prove that height is irrelevant.
 */
const ITEMS: readonly ItemSpec[] = [
  { turn: 5, kind: 'user', absTop: 0, height: 78 },
  { turn: 5, kind: 'assistant-step', absTop: 78, height: 1_500 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 1_578, height: 100 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 1_678, height: 500 },
  /*
   * Content past the end of the last turn. Without it the newest turn sits at
   * the bottom of the conversation and cannot be staged either (ROUND 5's live
   * failure), so the positive path would have nothing to prove itself against.
   */
  { turn: NOTICE_TURN + 1, kind: 'assistant-reasoning', absTop: 2_178, height: 4_000 },
]

/*
 * Two candidates with opposite prospects, which is the ordering ROUND 5 actually
 * hit. Pushing a reply below the band is done by scrolling *up*, so the room that
 * matters lies **above** the reply:
 *
 *   - turn 5 sits at the very top of the conversation. Its staging target is a
 *     negative `scrollTop` (78 − 1 203 − 48), which clamps at 0 and leaves the
 *     reply exactly where it was. Unstageable, whatever its reply looks like.
 *   - turn 6, the notice's own turn, sits at the bottom with 4 400 px of filler
 *     above it and a band's worth of content beneath, so its staging target is
 *     reachable.
 *
 * The runner therefore has to take turn 6 or it can never prove A2. Newest-first
 * happens to agree here, so this fixture is about *targeting* rather than about
 * the ordering rule; the dedicated `chooseTarget` tests below cover the case a
 * scene cannot separate, where the newest candidate is the unstageable one.
 *
 * Two properties of the scene are load-bearing, and both were found by running
 * it rather than by reasoning about it:
 *
 *   - `contentHeight` must clear the band by enough to reach the wanted
 *     position. With a document no taller than the viewport the scroll range is
 *     zero, every staging clamps at 0, and even the stageable turn is judged
 *     unstageable.
 *   - The *stageable* turn must have more than a band's worth of content above
 *     its reply, which is exactly what turn 5, at the top, lacks. The filler
 *     between them is not a turn row, so it never joins either turn — it only
 *     supplies the scroll range.
 */
const NEWEST_TURN_AT_THE_BOTTOM_ITEMS: readonly ItemSpec[] = [
  { turn: 5, kind: 'user', absTop: 0, height: 78 },
  { turn: 5, kind: 'assistant-step', absTop: 78, height: 500 },
  { turn: 4, kind: 'assistant-reasoning', absTop: 578, height: 4_400 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 5_000, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 5_078, height: 500 },
]
/** Scroll room for `NEWEST_TURN_AT_THE_BOTTOM_ITEMS`: 6 000 − 1 203 = 4 797 px. */
const NEWEST_TURN_AT_THE_BOTTOM_CONTENT_HEIGHT = 6_000

/*
 * A reply **far taller than the band** (3 000 px against 1 203 px), with a full
 * conversation above it.
 *
 * This is the layout the old geometry model ruled out and the one A2 most needs:
 * only the reply's *top edge* has to leave the band, so a tall reply stages
 * exactly like a short one — the remainder of it is simply still running below
 * the fold, which is what the counterexample is supposed to look like. The
 * removed `groupHeight < bandHeight` condition rejected it, and ROUND 5 then
 * spent a live run unable to construct A2 at all.
 *
 * Arithmetic: the reply's top is at 1 578, so the staging wants
 * `1 578 − 1 203 − 48 = 327` px of scroll, which the content (6 000 px against a
 * 1 203 px band) easily allows. At that scroll the notice turn's head row sits at
 * 1 249–1 327 — 30 px inside the band — while the reply's top lands at 1 327,
 * exactly one margin below the band's 1 279 bottom edge.
 */
const TALL_REPLY_WITH_ROOM_ITEMS: readonly ItemSpec[] = [
  { turn: 4, kind: 'assistant-reasoning', absTop: 0, height: 1_500 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 1_500, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 1_578, height: 3_000 },
]

/*
 * The same tall reply with nothing above it: the turn opens the conversation, so
 * its staging target is `78 − 1 203 − 48 = −1 173` and clamps at 0.
 *
 * This is the failure the report has to name correctly — the room *above* the
 * reply is what is missing. Height is not the obstacle, and 9 000 px of content
 * below it proves that: no amount of room beneath a reply can help, because
 * scrolling down moves it further *into* the band.
 */
const TALL_REPLY_NO_ROOM_ABOVE_ITEMS: readonly ItemSpec[] = [
  { turn: NOTICE_TURN, kind: 'user', absTop: 0, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 78, height: 3_000 },
]

/*
 * The wanted position lies past the *end* of the content instead of before its
 * start: the viewport is shorter than the scroll container (900 px against
 * 1 203 px), so the reply's top can be parked below the band even though the
 * container cannot scroll as far as the staging asks.
 *
 * That clamp overshoots downwards, which is why it is recorded and not treated as
 * a failure — the reply ends up *further* below the band than requested. The
 * staging asks for `2 800 − 824 − 48 = 1 928` against a maximum of
 * `3 000 − 1 203 = 1 797`, lands on 1 797, and carries the reply clear anyway,
 * with the turn's process row left inside the band.
 */
const PAST_CONTENT_END_ITEMS: readonly ItemSpec[] = [
  { turn: NOTICE_TURN, kind: 'turn-process', absTop: 1_900, height: 200 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 2_700, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 2_800, height: 100 },
]
/** Content height for `PAST_CONTENT_END_ITEMS`; the reply ends at 2 900. */
const PAST_CONTENT_END_CONTENT_HEIGHT = 3_000
/** Viewport height for `PAST_CONTENT_END_ITEMS`: shorter than the container. */
const PAST_CONTENT_END_VIEWPORT_HEIGHT = 900

/*
 * The live shape the runner has to survive: a fresh conversation mints its first
 * notice for turn 1, whose reply has only the opening user row above it, so its
 * staging target is `78 − 1 203 − 48 = −1 173` and clamps at 0 — unstageable
 * however long the runner holds it. Turn 2, answered afterwards, has turn 1's
 * 1 500 px reply above it, so its own target is `1 656 − 1 203 − 48 = 405` and is
 * perfectly storable.
 *
 * A runner that returns on the first unconfirmed notice spends its whole window on
 * turn 1 and reports a SKIP that says nothing about the product — ROUND 5's
 * `requiredScrollTop=-821`. The waiter has to refuse turn 1, say why, and keep the
 * window open for turn 2.
 */
const LATE_TURN_ITEMS: readonly ItemSpec[] = [
  { turn: 1, kind: 'user', absTop: 0, height: 78 },
  { turn: 1, kind: 'assistant-step', absTop: 78, height: 1_500 },
  { turn: 2, kind: 'user', absTop: 1_578, height: 78 },
  { turn: 2, kind: 'assistant-step', absTop: 1_656, height: 500 },
]
/** Content height for `LATE_TURN_ITEMS`: 1 656 + 500 = 2 156, plus room to scroll. */
const LATE_TURN_CONTENT_HEIGHT = 4_000

/*
 * The live starting position of a fresh notice: the page is anchored to the
 * newest content, so the reply is **already inside the band** when the runner
 * begins. Here the reply (absTop 5 000, 500 px tall) starts 203 px inside it,
 * with the turn's head row immediately above.
 *
 * The staging target is `5 000 − 1 203 − 48 = 3 749`, which is reachable, and
 * landing on it leaves the reply's top exactly 48 px below the band while the
 * head row still overlaps it by 32 px. Subtracting that 203 px "shortfall" — which
 * is what the runner did, reading the starting overlap as if it were an
 * unachieved correction — scrolls to 3 546 instead, throws the head row 171 px out
 * of the band, and turns a provable counterexample into a SKIP. Measured live in
 * ROUND 7: asked for 4 881, landed with the reply 493 px clear instead of 48.
 */
const OVERLAPPING_REPLY_ITEMS: readonly ItemSpec[] = [
  { turn: NOTICE_TURN, kind: 'user', absTop: 4_920, height: 80 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 5_000, height: 500 },
]
/** Content height for `OVERLAPPING_REPLY_ITEMS`: 5 500 px of content, 4 797 px of room. */
const OVERLAPPING_REPLY_CONTENT_HEIGHT = 6_000
/** Where the page sits before the runner stages anything: the bottom of the content. */
const OVERLAPPING_REPLY_START_SCROLL = 4_000

/*
 * A stageable notice whose turn has **nothing to keep on screen**: one reply and no
 * user row, no visible process row, nothing but the `turn-tail` beneath it. This is
 * the shape ROUND 7 hit live on a goal-continuation turn — A2 skipped with
 * `otherRowOverlap=-453` after a perfectly successful staging, which says nothing
 * about the product and wastes the run.
 *
 * Turn 2 is the real thing: a user message turn far enough down the conversation to
 * be stageable, with a head row that stays 32 px inside the band once the reply
 * leaves. The waiter must refuse turn 1 for the right reason and use turn 2.
 */
const NO_HEAD_ROW_ITEMS: readonly ItemSpec[] = [
  { turn: 1, kind: 'assistant-step', absTop: 3_000, height: 500 },
  { turn: 2, kind: 'user', absTop: 3_600, height: 80 },
  { turn: 2, kind: 'assistant-step', absTop: 3_680, height: 500 },
]
/** Content height for `NO_HEAD_ROW_ITEMS`: 4 180 px of content, 4 797 px of room. */
const NO_HEAD_ROW_CONTENT_HEIGHT = 6_000

/*
 * The notice turn's head row is more than a band height above its reply, so
 * pushing the reply off screen pushes the whole turn off screen. The reply is
 * off screen and nothing else of the turn is: this must not be reported as the
 * counterexample, because it only proves that an off-screen conversation is not
 * observed.
 */
const TURN_ENTIRELY_OFF_SCREEN_ITEMS: readonly ItemSpec[] = [
  { turn: 5, kind: 'user', absTop: 0, height: 78 },
  { turn: 5, kind: 'assistant-step', absTop: 78, height: 2_000 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 2_078, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 3_556, height: 3_000 },
]

/*
 * At `scrollTop = 0` the reply's top edge sits 0.4 px inside the band, and the
 * staging cannot do better because it is clamped at the top of the
 * conversation. The shipping `isTurnVisible()` uses the raw `bottom - top > 0`
 * and therefore counts this reply as on screen, so the counterexample was never
 * held — the runner's own `Math.round()` used to turn 0.4 px into a clean zero
 * and claim a PASS.
 */
const SUB_PIXEL_REPLY_ITEMS: readonly ItemSpec[] = [
  { turn: 5, kind: 'user', absTop: 0, height: 1_124.6 },
  { turn: NOTICE_TURN, kind: 'user', absTop: 1_124.6, height: 78 },
  { turn: NOTICE_TURN, kind: 'assistant-step', absTop: 1_202.6, height: 3_000 },
]

/*
 * A short reply whose turn opens the conversation, so the staging target is above
 * the start of the content and clamps at 0. Height is not the obstacle here —
 * 300 px is a quarter of the band — which is what makes this the fixture that
 * isolates *room above* as the reason the staging fails. The two tall-reply
 * fixtures above cover the same failure and the successful case respectively, so
 * a report that blames height can be told apart from one that names the room.
 */
const NO_ROOM_ABOVE_ITEMS: readonly ItemSpec[] = [
  { turn: 4, kind: 'assistant-reasoning', absTop: 0, height: 300 },
  { turn: 5, kind: 'user', absTop: 300, height: 78 },
  { turn: 5, kind: 'assistant-step', absTop: 378, height: 300 },
]
/** Scroll room for `NO_ROOM_ABOVE_ITEMS`: 1 200 − 1 203, floored at 0 px. */
const NO_ROOM_ABOVE_CONTENT_HEIGHT = 1_200

/** A page double that reports geometry which actually moves when it scrolls. */
function makePage(options: {
  reportSeenWhenInView: boolean
  holdExtraMs: number
  items?: readonly ItemSpec[]
  contentHeight?: number
  /** Window height; defaults to the container's bottom, i.e. an unclipped band. */
  innerHeight?: number
  /** Where the scroll container starts; the live page starts at the newest content. */
  initialScrollTop?: number
  /** What the host answers `/seen` with; `accept` also retires the notice. */
  seenResponse?: 'accept' | 'deny' | 'refuse'
  /** How many `/notices` polls the fake client waits before it starts reporting. */
  enableSeenAfterPolls?: number
  /** How long the runner keeps waiting for a storable notice; 0 means "look once". */
  waitForNoticeMs?: number
  /** A notice that only appears once `lateNoticeAfterPolls` polls have happened. */
  lateNoticeTurn?: number
  /** How many `/notices` polls pass before `lateNoticeTurn` is advertised. */
  lateNoticeAfterPolls?: number
  /**
   * Turns the stub advertises an unconfirmed notice for, oldest first. More than
   * one is what lets a test tell the runner's choice of target apart: the fake
   * client only marks `NOTICE_ID` as seen, so the first entry is the one the
   * positive phase resolves and the later ones exist to be *not* chosen.
   */
  noticeTurns?: readonly number[]
}) {
  const items = options.items ?? ITEMS
  const contentHeight = options.contentHeight ?? CONTENT_HEIGHT
  const innerHeight = options.innerHeight ?? SCROLL_BOTTOM
  const noticeTurns = options.noticeTurns ?? [NOTICE_TURN]
  const scroll = { top: options.initialScrollTop ?? 0 }
  const seenNoticeIds = new Set<string>()
  const listeners = new Map<string, Array<(event: { type: string }) => void>>()

  const itemElements = items.map(spec => ({
    getAttribute: (name: string): string | null => name === 'data-chat-turn'
      ? String(spec.turn)
      : name === 'data-chat-flow-kind' ? spec.kind : null,
    getBoundingClientRect: () => {
      const top = spec.absTop - scroll.top + SCROLL_TOP
      return { top, bottom: top + spec.height, width: 800, height: spec.height }
    },
  }))

  /*
   * Does the running fake client currently consider the notice turn's reply
   * readable? Mirrors what the shipping client does: clip the reply's box to the
   * scroll container and ask whether anything is left. A fixed `scrollTop`
   * threshold cannot answer this across fixtures, because where the staging
   * lands depends on the turn's absolute position — and a double that reports at
   * the wrong moment makes a gate look like it passed for the wrong reason.
   */
  const replyIsReadable = (turn: number): boolean => {
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const spec of items) {
      if (spec.turn !== turn || spec.kind !== 'assistant-step' || spec.height <= 0) continue
      const itemTop = spec.absTop - scroll.top + SCROLL_TOP
      if (itemTop < top) top = itemTop
      if (itemTop + spec.height > bottom) bottom = itemTop + spec.height
    }
    if (bottom <= top) return false
    return Math.min(bottom, SCROLL_BOTTOM) - Math.max(top, SCROLL_TOP) > 0
  }

  const scrollElement: Record<string, unknown> = {
    scrollHeight: contentHeight,
    clientHeight: BAND_HEIGHT,
    getBoundingClientRect: () => ({
      top: SCROLL_TOP,
      bottom: SCROLL_BOTTOM,
      width: 1_200,
      height: BAND_HEIGHT,
    }),
  }
  Object.defineProperty(scrollElement, 'scrollTop', {
    get: () => scroll.top,
    set: (value: number) => { scroll.top = value },
    enumerable: true,
  })

  const flowElement = {
    querySelector: (selector: string) => (selector === '[data-chat-turn]' ? (itemElements[0] ?? null) : null),
    querySelectorAll: (selector: string) => (selector === '[data-chat-turn]' ? itemElements : []),
  }

  const documentElement = {
    visibilityState: 'visible' as const,
    hasFocus: () => true,
    documentElement: {},
    querySelector: (selector: string) => selector === '[data-chat-flow]'
      ? flowElement
      : selector === '[data-conversation-scroll]' ? scrollElement : null,
    querySelectorAll: (selector: string) => selector === "[data-phase='active']"
      ? []
      : selector === '[data-chat-turn]' ? itemElements : [],
  }

  /**
   * What the host answers a `/seen` POST with, and whether it retires the notice.
   *
   * `accept` is the honest path; `deny` answers 200 with `accepted: false` and
   * `refuse` answers 500, and neither retires the notice — the two ways Gate A can
   * fail *because of the host* rather than because the page never reported.
   */
  const seenResponse = options.seenResponse ?? 'accept'
  /** How many `/notices` polls the fake client waits before it starts reporting. */
  const enableSeenAfterPolls = options.enableSeenAfterPolls ?? 0
  /**
   * A notice that only shows up after a few polls, i.e. a *later run* settling
   * while the runner is already waiting. This is the live shape the runner has to
   * survive: the first notice of a fresh conversation points at a turn whose reply
   * cannot be staged, and the usable one only exists once another turn has been
   * answered.
   */
  const lateNoticeTurn = options.lateNoticeTurn ?? null
  const lateNoticeAfterPolls = options.lateNoticeAfterPolls ?? 1
  let noticesPolls = 0

  /**
   * Response-shaped object the runner's sniffer can read.
   *
   * `clone()` matters: the sniffer observes `/seen` answers by cloning the
   * response, exactly as it does against the real fetch, so a double without it
   * would hide the `accepted` flag and make every refusal path look like a plain
   * success.
   */
  const jsonResponse = (status: number, payload: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    clone: () => ({ json: async () => payload }),
    json: async () => payload,
  })

  /** Stand-in for the host's three routes. `/seen` really retires the notice. */
  const fetchStub = async (input: unknown, init?: { method?: string, body?: unknown }) => {
    const url = String(input)
    if (url.indexOf('/pet-bridge/notices') !== -1) {
      noticesPolls += 1
      /*
       * The first advertised notice retires on `/seen` (the fake client only
       * reports that one), so the list drains from the front and the runner's
       * *choice* among the rest is what a multi-notice test observes.
       */
      const advertised = lateNoticeTurn !== null && noticesPolls >= lateNoticeAfterPolls
        ? [...noticeTurns, lateNoticeTurn]
        : [...noticeTurns]
      const notices = advertised
        .map((turn, index) => ({
          noticeId: index === 0 ? NOTICE_ID : `${NOTICE_ID}-${index}`,
          sessionId: SESSION_ID,
          runId: `run-smoke-${index}`,
          targetTurnRef: String(turn),
          reason: 'completed',
          completedAt: 1_000,
          state: 'shown',
        }))
        .filter(notice => !seenNoticeIds.has(notice.noticeId))
      return jsonResponse(200, { v: 1, revision: 1, sessionId: SESSION_ID, notices, seenDwellMs: 0 })
    }
    if (url.indexOf('/pet-bridge/seen') !== -1) {
      if (seenResponse === 'refuse') return jsonResponse(500, { v: 1, accepted: false })
      if (seenResponse === 'deny') return jsonResponse(200, { v: 1, accepted: false })
      seenNoticeIds.add(NOTICE_ID)
      return jsonResponse(200, { v: 1, accepted: true })
    }
    return jsonResponse(200, { v: 1, ok: true })
  }

  const windowStub: Record<string, unknown> = {
    innerHeight,
    scrollY: 0,
    fetch: fetchStub,
    addEventListener: (event: string, listener: (payload: { type: string }) => void) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
    },
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    __petAcceptConfig: {
      clickGraceMs: 0,
      settleMs: 0,
      holdExtraMs: options.holdExtraMs,
      dwellFallbackMs: 0,
      waitForNoticeMs: options.waitForNoticeMs ?? 0,
    },
  }

  // The real client half identifies its session on `focus`; without this the
  // runner cannot discover the session and stops before staging anything.
  //
  // It must go through `windowStub.fetch`, not the bare `fetchStub`: the runner
  // replaces `window.fetch` with a sniffer and only *wrapped* calls are visible
  // to it. Calling the stub directly would hide the one request that proves the
  // session, and discovery would then depend on the `/seen` timer happening to
  // fire first — which silently made the negative-path tests stop earlier than
  // they claimed to.
  listeners.set('focus', [() => {
    void (windowStub as unknown as {
      fetch: (input: unknown, init?: { method?: string, body?: unknown }) => Promise<unknown>
    }).fetch('/pet-bridge/visibility', {
      method: 'POST',
      body: JSON.stringify({
        v: 1, tabId: 'tab-smoke', sessionId: SESSION_ID, visible: true, focused: true, title: 'smoke',
      }),
    })
  }])

  /*
   * Optional fake client: posts `/seen` while the reply is readable, and only
   * while. That makes the positive phase pass for the right reason instead of
   * being handed a verdict, and it keeps quiet through the below-fold phase —
   * where the reply is deliberately not readable — without needing to know which
   * phase the runner is in.
   */
  let clientTimer: ReturnType<typeof setInterval> | null = null
  if (options.reportSeenWhenInView) {
    clientTimer = setInterval(() => {
      if (noticesPolls < enableSeenAfterPolls) return
      if (!replyIsReadable(NOTICE_TURN)) return
      void (windowStub.fetch as typeof fetchStub)('/pet-bridge/seen', {
        method: 'POST',
        body: JSON.stringify({
          v: 1, noticeId: NOTICE_ID, runId: 'run-smoke', sessionId: SESSION_ID,
          tabId: 'tab-smoke', observed: true,
        }),
      })
    }, 20)
  }

  return {
    window: windowStub,
    document: documentElement,
    stop: () => { if (clientTimer !== null) clearInterval(clientTimer) },
  }
}

/** Run the real runner file against a fresh page double. */
async function runRunner(options: {
  reportSeenWhenInView: boolean
  holdExtraMs: number
  items?: readonly ItemSpec[]
  contentHeight?: number
  innerHeight?: number
  initialScrollTop?: number
  seenResponse?: 'accept' | 'deny' | 'refuse'
  enableSeenAfterPolls?: number
  waitForNoticeMs?: number
  lateNoticeTurn?: number
  lateNoticeAfterPolls?: number
  noticeTurns?: readonly number[]
}): Promise<{ handle: RunnerHandle, window: Record<string, unknown>, output: string[] }> {
  const page = makePage(options)
  const code = readFileSync(RUNNER_PATH, 'utf8')
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    sessionStorage: globals.sessionStorage,
  }

  globals.window = page.window
  globals.document = page.document
  globals.location = { href: 'http://127.0.0.1:3080/' }
  globals.sessionStorage = { getItem: () => 'tab-smoke' }

  const output: string[] = []
  const realLog = console.log
  console.log = (...parts: unknown[]) => { output.push(parts.map(part => String(part)).join(' ')) }

  try {
    // Indirect eval: the runner is a browser script, so it must run in global
    // scope with the stubbed globals, not in this module's scope.
    const promise = (0, eval)(code) as Promise<void>
    await promise
  } finally {
    console.log = realLog
    page.stop()
    globals.window = saved.window
    globals.document = saved.document
    globals.location = saved.location
    globals.sessionStorage = saved.sessionStorage
  }

  const handle = page.window.__petAccept as RunnerHandle
  return { handle, window: page.window, output }
}

/** Verdict for one check id, or undefined when the runner never emitted it. */
const verdictOf = (handle: RunnerHandle, id: string): Verdict | undefined =>
  handle.checks.find(check => check.id === id)?.verdict

describe('acceptance runner (tools/acceptance-client-page.js)', () => {
  it('completes a full pass against a scroll-aware page double', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      contentHeight: 5_056,
    })

    assert.ok(handle !== undefined, 'the runner must publish window.__petAccept')
    assert.equal(handle.sessionId, SESSION_ID, 'the runner discovers the session from the client')

    for (const id of [
      'A0-selectors',
      'A0-kinds',
      'A1-first-match-is-not-the-reply',
      'A-discover-session',
      'Y0-notices-route',
      'Y1-shown-is-still-offered',
      'A2-counterexample',
    ]) {
      assert.equal(verdictOf(handle, id), 'PASS', `${id} should pass (output: ${output.join(' | ')})`)
    }

    // D2 in one line: the pet already displayed this notice, and the page is
    // still offered it — which is what lets the popup be retracted.
    assert.equal(handle.checks.find(check => check.id === 'Y1-shown-is-still-offered')?.detail.includes('1 already displayed'), true)
  })

  it('does not pass Gate A unless a client actually reported /seen', async () => {
    const { handle } = await runRunner({ reportSeenWhenInView: false, holdExtraMs: 0, contentHeight: 5_056 })

    // The runner staged the reply inside the band and the sampled geometry said
    // so — but nothing posted `/seen`, so the honest verdict is FAIL.
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'FAIL')
    assert.equal(
      handle.checks.find(check => check.id === 'A3-gate-a')?.detail.includes('new /seen posts=0'),
      true,
      'the failure must name the missing report, not the geometry',
    )
  })

  it('passes Gate A once the client reports /seen and the notice leaves the list', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: true,
      holdExtraMs: 400,
      contentHeight: 5_056,
    })

    assert.equal(verdictOf(handle, 'A3-gate-a'), 'PASS')
    assert.equal(verdictOf(handle, 'A2-counterexample'), 'PASS', 'the negative phase must still be quiet')
    // D2: the notice was parked in `shown` while the page was still being
    // offered it, which is the state the old `pendingFor()` dropped.
    assert.equal(verdictOf(handle, 'Y2-shown-survives-delivery'), 'PASS')
    assert.equal(
      handle.requests.some(entry => entry.url.indexOf('/pet-bridge/seen') !== -1),
      true,
    )
  })

  /*
   * Gate A's verdicts must distinguish who did what. Below are the three ways the
   * positive phase can end that are *not* "the product failed", plus the refusal
   * that is the host's own fault. All four used to collapse into one FAIL, which
   * is how ROUND 5 spent a live run chasing a client that had already reported.
   */
  it('skips Gate A rather than reusing a notice the below-fold phase could not stage', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: TALL_REPLY_NO_ROOM_ABOVE_ITEMS,
      contentHeight: 9_000,
      noticeTurns: [NOTICE_TURN],
    })

    assert.equal(verdictOf(handle, 'A2-counterexample'), 'SKIP')
    const detail = handle.checks.find(check => check.id === 'A3-gate-a')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'SKIP')
    assert.equal(detail.includes('A2=SKIP'), true, `the skip must name the missing precondition: ${detail}`)
    assert.equal(
      detail.includes('staged below the fold'),
      true,
      `the skip must say what a usable run needs: ${detail}`,
    )
  })

  it('skips Gate A when this tab had already reported the notice before the baseline', async () => {
    /*
     * The reply is on screen from the very start — this turn opens the
     * conversation, so nothing can be staged below the fold — and the host
     * answers `accepted: false` so the notice stays on offer. The page therefore
     * reports the target notice early and the run continues. A baseline taken now
     * would make the "no new reports" that follows look like a product failure,
     * which is exactly the misreading this branch exists to prevent.
     */
    const { handle } = await runRunner({
      reportSeenWhenInView: true,
      holdExtraMs: 0,
      items: TALL_REPLY_NO_ROOM_ABOVE_ITEMS,
      contentHeight: 9_000,
      seenResponse: 'deny',
      noticeTurns: [NOTICE_TURN],
    })

    const detail = handle.checks.find(check => check.id === 'A3-gate-a')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'SKIP')
    assert.equal(
      detail.includes('already posted /seen'),
      true,
      `the skip must attribute the earlier report: ${detail}`,
    )
  })

  it('fails Gate A when the host answers accepted=false to a report this tab made', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: true,
      holdExtraMs: 0,
      items: TALL_REPLY_WITH_ROOM_ITEMS,
      contentHeight: 6_000,
      seenResponse: 'deny',
      // Hold the fake client back until the baseline has been taken, so the
      // report it makes is the one the positive stage is measuring.
      enableSeenAfterPolls: 2,
    })

    const detail = handle.checks.find(check => check.id === 'A3-gate-a')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'FAIL')
    assert.equal(
      detail.includes('accepted=false'),
      true,
      `the failure must blame the host's refusal, not the page: ${detail}`,
    )
  })

  it('fails Gate A when the host refuses the report with a 500', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: true,
      holdExtraMs: 0,
      items: TALL_REPLY_WITH_ROOM_ITEMS,
      contentHeight: 6_000,
      seenResponse: 'refuse',
      enableSeenAfterPolls: 2,
    })

    const detail = handle.checks.find(check => check.id === 'A3-gate-a')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'FAIL')
    assert.equal(detail.includes('HTTP 500'), true, `the failure must quote the status: ${detail}`)
  })

  it('reports the run against the notice quadruple it actually judged', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      contentHeight: 5_056,
    })

    assert.equal(
      handle.target?.noticeId,
      NOTICE_ID,
      'the report must carry the noticeId the gates were judged against',
    )
    assert.equal(handle.target?.targetTurnRef, String(NOTICE_TURN))
    assert.equal(handle.target?.sessionId, SESSION_ID)
    assert.equal(handle.target?.runId, 'run-smoke-0')
    assert.equal(
      verdictOf(handle, 'A0-target-quadruple'),
      'PASS',
      'the notice quadruple must agree with the page session and the staged turn',
    )
  })

  /*
   * The two scenarios below are the ones that used to be reported as PASS. Both
   * are geometries where the counterexample was never actually staged, and a
   * gate that reports PASS for them is worse than no gate: it converts "the
   * scenario did not happen" into "the rule holds".
   */
  it('does not pass A2 when the reply and every other row of the turn are off screen', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: TURN_ENTIRELY_OFF_SCREEN_ITEMS,
      contentHeight: 7_000,
    })

    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'SKIP',
      'a turn that is entirely off screen must not be reported as the D1 counterexample',
    )
    assert.equal(
      handle.checks.find(check => check.id === 'A2-counterexample')?.detail.includes('weaker variant'),
      true,
      'the skip has to name why the geometry is not the one the plan asks for',
    )
  })

  it('does not pass A2 when the reply overlaps the band by a fraction of a pixel', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: SUB_PIXEL_REPLY_ITEMS,
      contentHeight: 4_300,
    })

    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'SKIP',
      'a 0.4 px overlap is still an on-screen reply for isTurnVisible(), so the counterexample was not held',
    )
    assert.equal(
      handle.checks.find(check => check.id === 'A2-counterexample')?.detail.includes('clamped'),
      true,
      'the skip has to say the staging was clamped, not that the geometry disagreed',
    )
  })

  it('records both gates as unproven when no notice can be staged', async () => {
    // No `assistant-step` anywhere: without a real reply there is nothing to
    // stage, and neither gate may quietly disappear from the report.
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: [{ turn: 5, kind: 'user', absTop: 0, height: 78 }],
      contentHeight: 2_000,
    })

    assert.equal(verdictOf(handle, 'A2-counterexample'), 'SKIP')
    assert.equal(verdictOf(handle, 'A3-gate-a'), 'SKIP')
  })

  /*
   * Every published handle must carry `sessionId`, including the early returns.
   * Omitting it on the "no notice" path made the driver's own session check
   * report `page is on undefined` — a failure attributed to the page when the
   * page was on the right session all along. Measured live in ROUND 5.
   */
  it('always publishes the session it discovered, even when it stops early', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: [{ turn: 5, kind: 'user', absTop: 0, height: 78 }],
      contentHeight: 2_000,
    })

    assert.equal(
      handle.sessionId,
      SESSION_ID,
      'the early return still has to identify the page, or the driver misreports the session',
    )
  })

  /*
   * ROUND 5's live failure, turned into geometry. The newest turn sits at the end
   * of the conversation with a reply taller than the band, so it cannot be pushed
   * below the fold at all; a runner that picks it can never prove A2. Turn
   * NOTICE_TURN sits higher up and is short enough to stage, so the honest
   * outcome is a PASS on that turn — which makes this a test about the *choice*
   * of target rather than about luck.
   */
  it('stages a turn that can actually be proven instead of the newest one', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: true,
      holdExtraMs: 400,
      items: NEWEST_TURN_AT_THE_BOTTOM_ITEMS,
      contentHeight: NEWEST_TURN_AT_THE_BOTTOM_CONTENT_HEIGHT,
      noticeTurns: [NOTICE_TURN, 5],
    })

    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `A2 must be proven against the stageable turn (output: ${output.join(' | ')})`,
    )
    /*
     * A2 passing is *not* enough on its own, and neither is "some line mentions
     * turn 6": the run logs a watching line per phase, so an `.some()` over the
     * whole output is satisfied by the phase that *did* stage turn 6 even when
     * the other phase picked turn 5. Assert the negative directly.
     *
     * Turn 5 is at the top of the conversation, so its staging target is above
     * the start of the content and clamps at 0: it can never be carried clear of
     * the band, and choosing it proves nothing. Only turn 6, with 4 400 px of
     * conversation above its reply and a band's worth of content beneath it, can
     * hold the counterexample.
     */
    assert.equal(
      output.some(line => line.includes('watching notice') && line.includes('turn 5,')),
      false,
      `the runner must not target the unstageable newest turn (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('watching notice') && line.includes(`turn ${NOTICE_TURN},`)),
      true,
      `the runner must target the stageable turn ${NOTICE_TURN} (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('staged below-fold: result overlap=-')),
      true,
      'the counterexample must actually be held, with the reply clear of the band',
    )
  })

  /*
   * When *no* candidate can be staged the runner must still say why, in numbers.
   * "overlap=467, clamped" cost ROUND 5 a whole diagnostic cycle because it did
   * not distinguish "the page is slow" from "this reply cannot be carried clear
   * of the band" — and, as it turned out, the missing figure was *which end of the
   * conversation ran out*.
   *
   * The fixture isolates the room-above failure: the reply is a quarter of the
   * band's height, so height cannot be responsible, and the turn opens the
   * conversation, so the content before it is what is short.
   */
  it('names the missing room above the reply when nothing can be staged', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: NO_ROOM_ABOVE_ITEMS,
      contentHeight: NO_ROOM_ABOVE_CONTENT_HEIGHT,
      noticeTurns: [5],
    })

    const detail = handle.checks.find(check => check.id === 'A2-counterexample')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A2-counterexample'), 'SKIP')
    assert.equal(detail.includes('reply'), true, `the skip must size the reply: ${detail}`)
    assert.equal(detail.includes('vs band'), true, `the skip must size the band: ${detail}`)
    assert.equal(detail.includes('wanted scrollTop'), true, `the skip must name the staging target: ${detail}`)
    assert.equal(detail.includes('of max'), true, `the skip must name the scroll ceiling: ${detail}`)
    assert.equal(
      detail.includes('content above the reply is 841px short'),
      true,
      `the skip must blame the room above the reply, not the reply's height: ${detail}`,
    )
  })

  /*
   * The counterexample A2 most needs, and the one the old model refused to
   * attempt: a reply far taller than the band, with a full conversation above it.
   * Only the reply's top edge has to leave the band, so this must stage and pass —
   * and while the run holds it, the turn's head row is still on screen, which is
   * exactly the geometry the plan asks for.
   */
  it('stages a reply taller than the band when there is room above it', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: TALL_REPLY_WITH_ROOM_ITEMS,
      contentHeight: 6_000,
    })

    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `a 3000px reply with room above it must be stageable (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('staged below-fold: result overlap=-')),
      true,
      'the reply must actually end up clear of the band, not merely be judged stageable',
    )
    assert.equal(
      output.some(line => line.includes('otherRowOverlap=62')),
      true,
      'the turn\'s own head row must still be inside the band while the reply is out of it',
    )
  })

  /*
   * The same tall reply with the conversation opening at it: the staging target
   * is a negative `scrollTop`, so no margin and no amount of content below can
   * help. The report has to say *that*, rather than blaming the reply's height —
   * the reason ROUND 5's diagnostics sent a reader looking in the wrong place.
   */
  it('blames the missing room above, not the reply height, when a tall reply cannot leave the band', async () => {
    const { handle } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: TALL_REPLY_NO_ROOM_ABOVE_ITEMS,
      contentHeight: 9_000,
      noticeTurns: [NOTICE_TURN],
    })

    const detail = handle.checks.find(check => check.id === 'A2-counterexample')?.detail ?? ''
    assert.equal(verdictOf(handle, 'A2-counterexample'), 'SKIP')
    assert.equal(detail.includes('reply 3000px vs band 1203px'), true, `the skip must size the reply against the band: ${detail}`)
    assert.equal(
      detail.includes('content above the reply is 1141px short'),
      true,
      `the skip must name the missing room above, even though the reply is also tall: ${detail}`,
    )
    assert.equal(
      detail.includes('wanted scrollTop'),
      true,
      'the skip must still publish the staging target',
    )
  })

  /*
   * The other end of the range, and the reason it is *recorded* rather than
   * treated as a shortage: when the wanted position lies past the end of the
   * content the clamp overshoots downwards, which pushes the reply further below
   * the band than asked. Skipping this layout as "no room below" — which the old
   * `stageable: clampedTo === wanted` rule did — would refuse a counterexample
   * that succeeds.
   *
   * A window shorter than the scroll container is what makes the wanted position
   * overshoot the content end here.
   */
  it('still stages when the wanted scroll position overshoots the content end', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: PAST_CONTENT_END_ITEMS,
      contentHeight: PAST_CONTENT_END_CONTENT_HEIGHT,
      innerHeight: PAST_CONTENT_END_VIEWPORT_HEIGHT,
    })

    assert.equal(
      output.some(line => line.includes('pastContentEnd')),
      true,
      `the shipped facts must record the overshoot (output: ${output.join(' | ')})`,
    )
    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `an overshooting clamp that clears the band must still count (output: ${output.join(' | ')})`,
    )
  })

  /*
   * The live-run trap the waiter exists for, as geometry.
   *
   * Turn 1's notice arrives first and cannot be staged; turn 2's arrives a couple
   * of polls later and can. The runner must refuse the first with its numbers,
   * keep waiting, and then prove A2 against the second — rather than burning its
   * whole window on a scenario that was never constructible.
   */
  it('waits past a notice it cannot stage and uses the next one that it can', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: LATE_TURN_ITEMS,
      contentHeight: LATE_TURN_CONTENT_HEIGHT,
      noticeTurns: [1],
      lateNoticeTurn: 2,
      lateNoticeAfterPolls: 2,
      // A real window, so the waiter has to loop rather than look once.
      waitForNoticeMs: 5_000,
    })

    assert.equal(
      output.some(line => line.includes('still waiting for a notice that can hold the below-fold counterexample')),
      true,
      `the waiter must say it is refusing a notice (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('refusing') && line.includes('1141px short')),
      true,
      `the refusal must name the shortage above turn 1's reply (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('watching notice') && line.includes('turn 2,')),
      true,
      `the second notice must become the target once it exists (output: ${output.join(' | ')})`,
    )
    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `A2 must be proven against the storable turn (output: ${output.join(' | ')})`,
    )
    assert.equal(handle.target?.targetTurnRef, '2', 'the published quadruple must be the notice that was used')
  })

  /*
   * The live starting position, as geometry: the reply is already on screen when
   * the runner begins, and there is a head row above it.
   *
   * Two things have to hold at once, and this is the only fixture where they can
   * be told apart: the reply must end up *strictly* below the band, and the turn's
   * head row must still be inside it. A staging that "corrects" for the reply's
   * starting overlap overshoots and satisfies only the first — the exact failure
   * ROUND 7 measured on turn 2 (`overlap=-493` where a 48 px margin was asked
   * for), which throws the head row out with the reply.
   */
  it('clears the band by one margin instead of by the reply\'s starting overlap', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: OVERLAPPING_REPLY_ITEMS,
      contentHeight: OVERLAPPING_REPLY_CONTENT_HEIGHT,
      initialScrollTop: OVERLAPPING_REPLY_START_SCROLL,
    })

    assert.equal(
      output.some(line => line.includes('staged below-fold: result overlap=-16')),
      true,
      `the reply must be parked one 16 px margin below the band, not further (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('otherRowOverlap=64')),
      true,
      `the turn's head row must still be inside the band (output: ${output.join(' | ')})`,
    )
    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `a head row on screen while the reply is out of it is the counterexample (output: ${output.join(' | ')})`,
    )
  })

  /*
   * Stageability is only half of A2. A turn can be perfectly stageable and still
   * be unusable, because once its reply leaves the band there is nothing of the
   * turn left on it — the live ROUND 7 goal-continuation turn, whose only
   * non-result row was the `turn-tail` *below* the reply. The waiter has to refuse
   * that one too, and say so, or the run is spent proving a weaker variant.
   */
  it('waits past a stageable notice whose turn would leave nothing on screen', async () => {
    const { handle, output } = await runRunner({
      reportSeenWhenInView: false,
      holdExtraMs: 0,
      items: NO_HEAD_ROW_ITEMS,
      contentHeight: NO_HEAD_ROW_CONTENT_HEIGHT,
      noticeTurns: [1],
      lateNoticeTurn: 2,
      lateNoticeAfterPolls: 2,
      waitForNoticeMs: 5_000,
    })

    assert.equal(
      output.some(line => line.includes('no other row to leave on screen')),
      true,
      `the refusal must name the missing head row, not the geometry (output: ${output.join(' | ')})`,
    )
    assert.equal(
      output.some(line => line.includes('watching notice') && line.includes('turn 2,')),
      true,
      `the user-message turn must become the target (output: ${output.join(' | ')})`,
    )
    assert.equal(
      verdictOf(handle, 'A2-counterexample'),
      'PASS',
      `A2 must be proven against the turn with a head row (output: ${output.join(' | ')})`,
    )
  })

  /*
   * The target-selection rule, tested directly.
   *
   * This exists because a page scene cannot separate the two rules: candidates
   * are sorted newest first, so a scene where the newest turn is stageable is
   * answered identically by "take the newest" and "take a stageable one". The
   * case that matters — newest unstageable, an older turn usable — is exactly the
   * live ROUND 5 geometry, and it is only reachable here.
   */
  it('prefers a stageable candidate over a newer unstageable one', async () => {
    const { handle } = await runRunner({ reportSeenWhenInView: false, holdExtraMs: 0, contentHeight: 5_056 })
    const choose = handle.chooseTarget
    assert.equal(typeof choose, 'function', 'the runner must publish the selection rule')

    const newestUnstageable: Candidate = { turn: 9, state: { belowFold: { stageable: false } } }
    const olderStageable: Candidate = { turn: 4, state: { belowFold: { stageable: true } } }

    assert.equal(
      choose?.([newestUnstageable, olderStageable]),
      olderStageable,
      'a provable turn must win over a newer turn that cannot be staged',
    )
    assert.equal(
      choose?.([olderStageable, newestUnstageable]),
      olderStageable,
      'the choice must not depend on the order the candidates arrive in',
    )
  })

  it('falls back to the newest candidate when none can be staged', async () => {
    const { handle } = await runRunner({ reportSeenWhenInView: false, holdExtraMs: 0, contentHeight: 5_056 })
    const choose = handle.chooseTarget

    const newest: Candidate = { turn: 9, state: { belowFold: { stageable: false } } }
    const older: Candidate = { turn: 4, state: { belowFold: { stageable: false } } }
    const unknown: Candidate = { turn: 7, state: { belowFold: null } }
    const usable: Candidate = { turn: 2, state: { belowFold: { stageable: true } } }

    assert.equal(choose?.([newest, older]), newest, 'with nothing stageable, newest still leads the attempt')
    /*
     * `belowFold: null` means the geometry could not be measured at all, which
     * must *not* count as stageable — if it did, the unmeasured turn would be
     * preferred over one that was genuinely measured. Here the unmeasured turn
     * leads the fallback, and a measured-but-unusable one loses to a usable one.
     */
    assert.equal(
      choose?.([unknown, newest]),
      unknown,
      'an unmeasured turn must not be preferred over a measured one as if it were stageable',
    )
    assert.equal(
      choose?.([unknown, usable]),
      usable,
      'a measured, stageable turn still wins over an unmeasured one',
    )
    assert.equal(choose?.([]), undefined, 'no candidates means no target')
  })
})
