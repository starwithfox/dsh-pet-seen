/**
 * In-page acceptance runner for the browser half of `dsh-pet-seen`.
 *
 * This is the active counterpart to `probe-client-page.js`. The probe only
 * *reports* geometry; this runner **drives** the page and then judges the
 * shipping client by its observable effect — did it actually `POST
 * /pet-bridge/seen`, and did the host stop listing the notice? It never trusts
 * its own copy of the visibility rule for the verdict (that copy is printed as
 * diagnostics only), because a test that re-implements the rule would pass
 * whenever the copy was wrong in the same way as the code.
 *
 * Checks it runs, mapped to `PLAN-ROUND2.md` §3:
 *
 * - **A0 selectors** — the upstream DOM contract still holds: `[data-chat-flow]`,
 *   `[data-conversation-scroll]`, and `data-chat-flow-kind` on the same element
 *   as `data-chat-turn`.
 * - **A1 D1 premise** — for a finished turn, the first `[data-chat-turn="N"]`
 *   match is *not* the reply: the `assistant-step` group sits elsewhere and is
 *   much taller.
 * - **A2 counterexample** — stage the turn so that a non-result row (the turn
 *   head) is on screen while the reply is entirely below the fold. Hold past the
 *   dwell. The client must **not** report `/seen` for that notice. This is the
 *   exact case ROUND 1 failed.
 * - **A3 gate A** — stage the reply inside the visible band, hold past the
 *   dwell, and require a `/seen` POST and the notice leaving `/notices`.
 * - **Y1 D2** — a notice the pet already displayed (`state: "shown"`) is still
 *   offered to the page, which is what lets the popup be retracted later.
 *
 * HOW TO USE
 *   1. Open the DSH page and hard-refresh it (Ctrl+Shift+R) so this tab runs the
 *      current client bundle.
 *   2. Press F12, switch to the Console tab, paste this whole file, press Enter.
 *      The selector and geometry checks (`A0`/`A1`) run immediately and are
 *      printed straight away — they need no notice and no focus.
 *   3. When it prints `CLICK ON THE PAGE NOW`, click the chat area (not the
 *      Console — console focus makes `document.hasFocus()` false and L3 can
 *      never fire; those phases are then reported as INCONCLUSIVE, not PASS).
 *   4. Notices only exist once a run settles. If the runner says there is none,
 *      leave the page focused and send a chat message; it polls for one and
 *      stages the reply the moment it appears.
 *   5. Wait for the `SUMMARY`, then click back into the Console to read it.
 *
 * It is safe to re-run; it only ever scrolls, reads, and lets the real client do
 * whatever it would have done anyway.
 *
 * @module tools/acceptance-client-page
 */

(async () => {
  'use strict'

  const TAG = '[pet-accept]'
  const log = (...parts) => console.log(TAG, ...parts)

  /**
   * Runner revision, printed first.
   *
   * The cheapest way to waste an acceptance round is to paste a stale copy out
   * of the clipboard — which is exactly what happened the first time this
   * runner was used, and it produced a plausible-looking `SKIP` from code that
   * had already been fixed. Printing a revision makes that visible in one line.
   */
  const RUNNER_VERSION = 'acceptance-6'

  /* --------------------------------------------------------------- tuning */

  /*
   * Overridable so the smoke test in `tests/acceptance-page.test.ts` can drive
   * the whole run in milliseconds, and so an operator can shorten the click
   * grace. Only read once, before anything is measured.
   */
  const config = (typeof window !== 'undefined' && window.__petAcceptConfig !== null
    && typeof window.__petAcceptConfig === 'object')
    ? window.__petAcceptConfig
    : {}
  const tuned = (name, fallback) => (typeof config[name] === 'number' ? config[name] : fallback)

  /** How long the operator gets to click back onto the page. */
  const CLICK_GRACE_MS = tuned('clickGraceMs', 8000)
  /** Settle time after a programmatic scroll before anything is judged. */
  const SETTLE_MS = tuned('settleMs', 600)
  /**
   * Extra time on top of the dwell before a conclusion may be drawn.
   *
   * Generous on purpose: after a programmatic scroll the client needs up to one
   * poll interval (plus the 500 ms floor) to re-target, and re-targeting restarts
   * the dwell clock, so the hold has to cover that latency as well as the dwell.
   */
  const HOLD_EXTRA_MS = tuned('holdExtraMs', 2500)
  /** Used only to estimate how long to hold when the host advertises nothing. */
  const DWELL_FALLBACK_MS = tuned('dwellFallbackMs', 1500)
  /**
   * How long to wait for an unconfirmed notice to appear.
   *
   * Notices are only minted when a run settles, so the operator usually has to
   * cause one by sending a chat message while this runner sits waiting. It has
   * to win a race to it: the client needs a poll (<=1 s) plus the dwell before
   * it reports, so polling every 400 ms and staging the reply off screen first
   * keeps the notice alive long enough to measure.
   */
  const WAIT_FOR_NOTICE_MS = tuned('waitForNoticeMs', 480000)

  /* ------------------------------------------------------- result bookkeeping */

  /** @type {Array<{id: string, verdict: string, detail: string}>} */
  const checks = []
  const record = (id, verdict, detail) => {
    checks.push({ id, verdict, detail })
    log(`${verdict}  ${id} :: ${detail}`)
  }

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /* ---------------------------------------------------------- fetch sniffer */

  /*
   * Installed before anything else. Two jobs: learn which session this tab is
   * on (the client tells the host in its own request bodies) and observe whether
   * the client actually reports an observation.
   */
  /*
   * A previous run may still have its wrapper installed. Drop it first, or a
   * re-paste would log every request once per layer.
   */
  try { window.__petAccept?.stop?.() } catch { /* nothing to unwind */ }

  const originalFetch = window.fetch.bind(window)
  /** @type {Array<{url: string, method: string, body: string|null, at: number, status: number|null, accepted: boolean|null}>} */
  const sniffed = []
  window.fetch = function (input, init) {
    /** The record for this call, when it is one of ours to watch. */
    let entry = null
    try {
      const url = String(input !== null && typeof input === 'object' && 'url' in input ? input.url : input)
      if (url.indexOf('pet-bridge') !== -1) {
        const rawBody = init === undefined ? null : init.body
        entry = {
          url,
          method: String((init === undefined ? undefined : init.method) ?? 'GET').toUpperCase(),
          body: typeof rawBody === 'string' ? rawBody : null,
          at: Date.now(),
          status: null,
          accepted: null,
        }
        sniffed.push(entry)
      }
    } catch {
      // A probe must never be able to break the page it measures.
    }
    const result = originalFetch(input, init)
    /*
     * Watch the host's answer without touching the promise the client awaits: the
     * request count alone cannot tell "the server took the observation" from "the
     * server refused it", and Gate A has to distinguish those. Both hooks swallow
     * their own failures — a response this probe cannot read is not the page's
     * problem, and the request is still counted.
     */
    if (entry !== null && entry.method === 'POST') {
      try {
        result.then((response) => {
          try {
            entry.status = typeof response.status === 'number' ? response.status : null
            response.clone().json().then(
              (payload) => {
                if (payload !== null && typeof payload === 'object' && typeof payload.accepted === 'boolean') {
                  entry.accepted = payload.accepted
                }
              },
              () => { /* no readable body; the status still stands */ },
            )
          } catch { /* cloned body unavailable (a stub response, or a stream already read) */ }
        }, () => { /* the request itself failed; the count still stands */ })
      } catch { /* not a thenable; nothing to observe */ }
    }
    return result
  }

  /** Every `/seen` POST the client has made for one notice. */
  const seenPostsFor = (noticeId) => sniffed.filter((entry) =>
    entry.url.indexOf('/pet-bridge/seen') !== -1
    && entry.body !== null
    && entry.body.indexOf(noticeId) !== -1)

  /** The session id this tab last told the host about, or null. */
  const sniffedSessionId = () => {
    for (let index = sniffed.length - 1; index >= 0; index -= 1) {
      const entry = sniffed[index]
      const fromUrl = /[?&]sessionId=([^&]+)/.exec(entry.url)
      if (fromUrl !== null) return decodeURIComponent(fromUrl[1])
      if (entry.body !== null) {
        try {
          const parsed = JSON.parse(entry.body)
          if (typeof parsed.sessionId === 'string' && parsed.sessionId !== '') return parsed.sessionId
        } catch {
          // Not JSON; keep looking.
        }
      }
    }
    return null
  }

  /* --------------------------------------------------------------- DOM side */

  const FLOW_SELECTOR = '[data-chat-flow]'
  const SCROLL_SELECTOR = '[data-conversation-scroll]'
  const ACTIVE_SELECTOR = "[data-phase='active']"
  const TURN_ATTRIBUTE = 'data-chat-turn'
  const KIND_ATTRIBUTE = 'data-chat-flow-kind'
  /** Keep in sync with `RESULT_KINDS` in src/client/visibility.ts. */
  const RESULT_KINDS = ['assistant-step', 'turn-error', 'turn-max-tokens']

  const query = (selector) => {
    const active = document.querySelector(ACTIVE_SELECTOR)
    return (active ?? document).querySelector(selector) ?? document.querySelector(selector)
  }

  const flow = query(FLOW_SELECTOR)
  const scroll = query(SCROLL_SELECTOR) ?? flow

  const turnOf = (element) => {
    const raw = element.getAttribute(TURN_ATTRIBUTE)
    if (raw === null || raw === '') return null
    const turn = Number(raw)
    return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
  }

  const flowItems = () => {
    for (const scope of [flow, document]) {
      if (scope === null || scope === undefined) continue
      const items = [...scope.querySelectorAll(`[${TURN_ATTRIBUTE}]`)]
      if (items.length > 0) return items
    }
    return []
  }

  /** The visible band: the scroll container clipped to the viewport. */
  const band = () => {
    const viewportTop = typeof window.scrollY === 'number' ? window.scrollY : 0
    const viewportBottom = viewportTop + window.innerHeight
    if (scroll === null || scroll === undefined) return { top: viewportTop, bottom: viewportBottom }
    const rect = scroll.getBoundingClientRect()
    return { top: Math.max(rect.top, viewportTop), bottom: Math.min(rect.bottom, viewportBottom) }
  }

  const unionBox = (items) => {
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const element of items) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.top < top) top = rect.top
      if (rect.bottom > bottom) bottom = rect.bottom
    }
    return bottom <= top ? null : { top, bottom }
  }

  /**
   * Signed overlap of one box with the visible band, **unrounded**.
   *
   * Rounding here was a real defect: a 0.4 px positive overlap became a clean
   * zero, the verdict read it as "off screen", and the counterexample silently
   * turned into an ordinary look at the answer. The shipping `isTurnVisible()`
   * tests `bottom - top > 0` on the raw numbers, so the gate has to use the raw
   * numbers too. Only printed diagnostics are rounded.
   */
  const overlap = (box) => {
    if (box === null) return null
    const visible = band()
    return Math.min(box.bottom, visible.bottom) - Math.max(box.top, visible.top)
  }

  /** Round a geometry value for display only, tolerating null. */
  const px = (value) => (value === null || value === undefined ? value : Math.round(value))

  /**
   * Everything the diagnostics need about one turn.
   *
   * `group`/`legacy` mirror `turnResultBox()` and the pre-D1 rule respectively;
   * they are printed for the report and are deliberately **not** the verdict.
   */
  const measure = (turn) => {
    const items = flowItems().filter((element) => turnOf(element) === turn)
    let group = null
    let groupKind = null
    for (const kind of RESULT_KINDS) {
      const box = unionBox(items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) { group = box; groupKind = kind; break }
    }
    /*
     * Deliberately no "(any item)" fallback. This mirrors `turnResultBox()` in
     * src/client/visibility.ts, which returns null instead of unioning the
     * turn's prompt and process rows: a turn with no result kind rendered has no
     * result to measure, and letting its user row or a tool row stand in would
     * hand the runner a "reply" the page never drew — and A2 a PASS it never
     * earned.
     */
    const legacy = items.length === 0 ? null : items[0].getBoundingClientRect()
    const legacyBox = legacy === null || legacy.width <= 0 || legacy.height <= 0
      ? null
      : { top: legacy.top, bottom: legacy.bottom }
    const answerItems = items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === 'assistant-step')
    /*
     * Everything of the turn that is *not* a result row — the head row and the
     * process disclosure. The counterexample needs one of these on screen while
     * the reply is not: "the reply is off screen" alone proves nothing, because
     * an entirely off-screen conversation is trivially unobserved.
     */
    const otherItems = items.filter((element) => !RESULT_KINDS.includes(element.getAttribute(KIND_ATTRIBUTE)))
    const otherBox = unionBox(otherItems)
    return {
      items,
      itemCount: items.length,
      kinds: items.map((element) => element.getAttribute(KIND_ATTRIBUTE)),
      groupKind,
      groupBox: group,
      groupOverlap: overlap(group),
      groupHeight: group === null ? 0 : Math.round(group.bottom - group.top),
      answerItems,
      otherItems,
      otherKinds: otherItems.map((element) => element.getAttribute(KIND_ATTRIBUTE)),
      otherBox,
      otherOverlap: overlap(otherBox),
      legacyBox,
      legacyOverlap: overlap(legacyBox),
      legacyHeight: legacyBox === null ? 0 : Math.round(legacyBox.bottom - legacyBox.top),
      /*
       * Evaluated per call, not cached on the object: the whole point is how the
       * answer to "can this be staged?" changes as the conversation scrolls.
       */
      get belowFold() {
        return group === null ? null : belowFoldFacts(group)
      },
      /*
       * Where the turn's other rows would sit once the reply is parked below the
       * band, as a signed overlap with the band.
       *
       * The geometry is affine in `scrollTop`, so shifting the union box by the
       * staging delta is exact rather than an approximation. It answers the half of
       * A2 that "the reply is off screen" does not: whether anything of the turn
       * *stays* on screen. Computed before any scroll is risked, because a run that
       * spends its window on a turn with no head row produces a SKIP that says
       * nothing about the product — measured live in ROUND 7 on a goal-continuation
       * turn, whose only non-result row was the `turn-tail` *below* the reply.
       *
       * @returns the projected overlap, or null when it cannot be projected.
       */
      get stagedOtherOverlap() {
        if (group === null || otherBox === null) return null
        if (scroll === null || scroll === undefined) return null
        const facts = belowFoldFacts(group)
        const delta = facts.clampedTo - scroll.scrollTop
        return overlap({ top: otherBox.top - delta, bottom: otherBox.bottom - delta })
      },
    }
  }

  /** Distance from the scroll container's content top to one viewport y. */
  const contentY = (viewportY) => {
    if (scroll === null || scroll === undefined) return viewportY
    return viewportY - scroll.getBoundingClientRect().top + scroll.scrollTop
  }

  /** Highest scrollTop the container will accept; 0 when it cannot scroll. */
  const maxScrollTop = () => {
    if (scroll === null || scroll === undefined) return 0
    return Math.max(0, (scroll.scrollHeight ?? 0) - (scroll.clientHeight ?? 0))
  }

  /**
   * Could this turn's reply be pushed below the fold, and how much room is left?
   *
   * Mirrors `stageReplyBelowFold()`'s arithmetic — only the missing-margin case,
   * which is the easiest of the three it tries — so the answer matches what the
   * staging will actually attempt rather than a parallel theory of it.
   *
   * Pushing the reply below the band means scrolling *up*: the wanted position is
   * `contentY(replyTop) - bandHeight - margin`, which parks the reply's top edge
   * one margin below the band's bottom edge and leaves the rest of the turn — the
   * head row and the process rows that sit between it and the reply — inside the
   * band. That is the whole counterexample, and what it needs is **room above the
   * reply**: with `wanted < 0` the container clamps at 0, the reply stays where it
   * is, and no margin can help. A reply at the very start of the conversation has
   * no such room, which is the failure ROUND 5 actually hit
   * (`requiredScrollTop=-821`, `clampedTo=0`).
   *
   * Reply *height* is deliberately not a condition, and requiring it was the
   * defect this replaced. An earlier version demanded `groupHeight < bandHeight`
   * on the theory that a reply at least as tall as the band cannot be moved clear
   * of it. That is backwards: only the reply's *top edge* has to leave the band,
   * and a 5 000 px reply leaves it exactly as easily as a 50 px one — the tall
   * reply is then simply still running below the fold, which is precisely the
   * situation A2 is trying to build. The height test rejected the one layout the
   * counterexample is most likely to be constructible in.
   *
   * `wanted > maxScrollTop` is recorded but is **not** a failure. Clamping to the
   * content end still lands *further* down than asked, so the reply clears the
   * band by even more; the two conditions coincide, because `wanted > max` is the
   * same inequality as "the clamp still clears the band". Treating it as a second
   * kind of shortage would have skipped a stageable layout — which is what the
   * earlier model did, `stageable` being `clampedTo === wanted`.
   *
   * @returns the figures behind the decision, plus whether staging can succeed.
   */
  const belowFoldFacts = (groupBox) => {
    const visible = band()
    const bandHeight = Math.max(0, visible.bottom - visible.top)
    const groupHeight = Math.max(0, groupBox.bottom - groupBox.top)
    const max = maxScrollTop()
    const wanted = Math.round(contentY(groupBox.top) - bandHeight - BELOW_FOLD_MARGINS_PX[0])
    /** How far short the content *before* the reply falls, in px; 0 when it suffices. */
    const roomAboveShort = Math.max(0, -wanted)
    /** How far past the content end the wanted position is; harmless, kept for the report. */
    const pastContentEnd = Math.max(0, wanted - max)
    return {
      bandHeight,
      groupHeight,
      currentScrollTop: scroll === null || scroll === undefined ? null : scroll.scrollTop,
      maxScrollTop: max,
      requiredScrollTop: wanted,
      clampedTo: Math.max(0, Math.min(max, wanted)),
      willClamp: wanted < 0 || wanted > max,
      roomAboveShort,
      pastContentEnd,
      /*
       * Room above the reply is the only thing that can stop this. `wanted >= 0`
       * says the container can reach a position that carries the reply clear.
       */
      stageable: wanted >= 0,
    }
  }

  /**
   * One sentence naming *why* a below-fold staging cannot work, with the numbers.
   *
   * Shared by the candidate log and the A2 skip detail so the report never says
   * "clamped" without saying which end ran out — the omission that cost ROUND 5 a
   * full diagnostic cycle.
   *
   * @param facts - the object returned by `belowFoldFacts()`.
   * @returns the explanation.
   */
  const describeBelowFold = (facts) => {
    if (facts === null) return 'the reply\'s geometry could not be measured at all'
    const shared = `reply ${px(facts.groupHeight)}px vs band ${px(facts.bandHeight)}px;`
      + ` staging wanted scrollTop ${px(facts.requiredScrollTop)},`
      + ` allowed ${px(facts.clampedTo)} of max ${px(facts.maxScrollTop)}`
    if (facts.roomAboveShort > 0) {
      return `${shared}; the content above the reply is ${px(facts.roomAboveShort)}px short of what that`
        + ' needs, so the reply cannot be pushed below the band at all (scrolling up is what moves it down)'
    }
    if (facts.pastContentEnd > 0) {
      return `${shared}; the wanted position lies ${px(facts.pastContentEnd)}px past the end of the content,`
        + ' which clamps further down rather than shorter and still carries the reply clear'
    }
    return `${shared}; the staging is reachable`
  }

  /**
   * Which candidate notice should the counterexample be staged against?
   *
   * Newest-first is the obvious ordering and the wrong one: the newest turn is
   * the likeliest to be unstageable, because a reply at the bottom of a short
   * conversation has no content *above* it to scroll back into, and pushing the
   * reply below the band is done by scrolling up. Measured live (ROUND 5): the
   * newest turn's reply was 5240 px against a ~1030 px band, the staging wanted
   * `scrollTop=-821` and clamped at `0`, and A2 could not be proven at all.
   * (The reply's height had nothing to do with it — see `belowFoldFacts()`.)
   *
   * So a candidate whose reply *can* be staged wins over one that merely happens
   * to be newer; newest-first only breaks ties among equally stageable (or
   * equally unstageable) candidates. Extracted and published in the report so
   * the rule can be tested directly, since a page-level scene cannot distinguish
   * "newest" from "stageable" when the newest candidate is also the stageable one.
   *
   * @param candidates - `[{ notice, turn, state }]`, already sorted newest first.
   * @returns the chosen entry, or `undefined` when there is nothing to choose.
   */
  const chooseTarget = (candidates) => {
    const usable = candidates.filter((entry) =>
      entry.state.belowFold !== null && entry.state.belowFold.stageable)
    return usable.length > 0 ? usable[0] : candidates[0]
  }

  /**
   * Scroll so the given content offset lands where asked.
   *
   * @returns whether the move was applied, and whether the target had to be
   *   clamped (which means the wanted position was past an end of the content,
   *   so the staging did not actually happen).
   */
  const scrollToContentY = (y) => {
    if (scroll === null || scroll === undefined) return { moved: false, clamped: false }
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    const wanted = Math.round(y)
    const applied = Math.max(0, Math.min(max, wanted))
    scroll.scrollTop = applied
    return { moved: true, clamped: applied !== wanted }
  }

  /**
   * Growing clearance for the below-fold staging, in px, **smallest first**.
   *
   * The margin has to clear the band without clearing the turn. Landing the
   * reply's top edge exactly on the band's bottom edge leaves a stray pixel of
   * overlap once the numbers are rounded and the page has re-laid-out, and one
   * pixel is enough for `isTurnVisible()` to count the reply as on screen — which
   * silently turns the counterexample into an ordinary look at the answer.
   * Measured live: exact-boundary staging reported `overlap=1`.
   *
   * But A2 also needs something of the same turn to *stay* in the band, and the
   * head row sits directly above the reply, so a clearance larger than that row is
   * as bad as no staging at all. Measured live (ROUND 7, turn 2): the row above the
   * reply was the turn's folded `turn-process` control, about 40 px tall, and a
   * 48 px margin pushed its top 8 px below the band's bottom edge — every other row
   * of the turn measured `overlap=-453`. 16 px clears the band by sixteen times the
   * rounding it guards against while leaving 24 px of that row on screen.
   *
   * Ascending order matters: the loop stops at the first margin that gets the reply
   * out, so trying the smallest first keeps as much of the turn visible as the
   * counterexample allows, and only escalates when the reply refuses to leave.
   */
  const BELOW_FOLD_MARGINS_PX = [16, 48, 192, 576]

  /**
   * Stage a turn so its reply sits below the fold while the rest of the turn —
   * the head row — stays inside it.
   *
   * Retries with growing clearance and corrects for whatever the previous
   * attempt actually achieved, so a retry never merely repeats the shortfall.
   *
   * @param turn - the turn whose reply must leave the band.
   * @returns whether the reply actually left the band, whether the scroll had to
   *   be clamped on the way, and a reason when it did not leave.
   */
  const stageReplyBelowFold = async (turn) => {
    let clamped = false
    for (const margin of BELOW_FOLD_MARGINS_PX) {
      const state = measure(turn)
      if (state.groupBox === null) return { staged: false, clamped, reason: 'no rendered result group' }
      const visible = band()
      const height = visible.bottom - visible.top
      /*
       * The target is absolute, not relative to where the reply is now:
       * `contentY(top) - bandHeight - margin` is the scroll position that parks
       * the reply's top edge exactly one margin below the band's bottom edge, and
       * every iteration re-measures, so a layout shift between the measure and
       * the scroll is already accounted for.
       *
       * Subtracting the overlap that is on screen right now was a live defect
       * (ROUND 7, turn 2). That overlap is not a shortfall from a previous
       * attempt — it is the reply's own visible height at the starting position,
       * which the target already accounts for — so the first attempt scrolled up
       * by it *again*. Measured: the staging asked for `scrollTop=4881` and left
       * the reply 493 px clear of the band instead of the intended 48. The
       * overshoot is harmless when all A2 wants is "the reply is off screen", but
       * it is fatal to A2's actual requirement, because the turn's own head row
       * — 78 px tall, immediately above the reply — gets thrown out of the band
       * along with it, and the counterexample becomes unprovable.
       */
      const move = scrollToContentY(contentY(state.groupBox.top) - height - margin)
      if (!move.moved) return { staged: false, clamped, reason: 'no scroll container' }
      clamped = clamped || move.clamped
      await sleep(140)
      const after = measure(turn)
      if (after.groupOverlap !== null && after.groupOverlap < 0) return { staged: true, clamped, reason: '' }
      /*
       * A clamp does not by itself end the attempt. It means the wanted position
       * was past an end of the content, but the position actually reached may
       * still have carried the reply clear of the band — a clamp at the bottom
       * overshoots downwards, and a shortfall the previous margin already
       * absorbed is gone. Only a clamp that still leaves the reply overlapping,
       * with no larger margin left to try, is a genuine failure.
       */
    }
    /*
     * Every margin tried and the reply is still inside the band. This used to
     * return `staged: true`, which claimed an attempt that plainly had not
     * succeeded: the caller re-measured and skipped it, so no verdict was ever
     * wrong, but the reason it printed blamed the band and the reply for
     * disagreeing about their own geometry instead of naming the real shortage.
     * Report the last measurement and why it could not be improved.
     */
    const last = measure(turn)
    return {
      staged: false,
      clamped,
      reason: `could not carry the reply clear of the band in ${BELOW_FOLD_MARGINS_PX.length} tries:`
        + ` result overlap=${px(last.groupOverlap)},`
        + (clamped
          ? ' and the scroll was clamped at an end of the conversation —'
          : ' and the scroll was applied in full, yet the reply stayed inside —')
        + ` ${describeBelowFold(last.belowFold)}`,
    }
  }

  /** Stage a turn so its reply fills the top of the visible band. */
  const stageReplyInView = (turn) => {
    const state = measure(turn)
    if (state.groupBox === null) return { staged: false, clamped: false, reason: 'no rendered result group' }
    const visible = band()
    const height = visible.bottom - visible.top
    const move = scrollToContentY(contentY(state.groupBox.top) - height * 0.15)
    return { staged: move.moved, clamped: move.clamped, reason: 'no scroll container' }
  }

  /* ------------------------------------------------------------ host routes */

  const getNotices = async (sessionId) => {
    const response = await originalFetch(
      `/pet-bridge/notices?sessionId=${encodeURIComponent(sessionId)}`,
      { credentials: 'same-origin' },
    )
    if (!response.ok) return { ok: false, status: response.status, notices: [], seenDwellMs: null }
    const payload = await response.json()
    return {
      ok: true,
      status: response.status,
      notices: Array.isArray(payload.notices) ? payload.notices : [],
      seenDwellMs: typeof payload.seenDwellMs === 'number' ? payload.seenDwellMs : null,
    }
  }

  /*
   * A notice only exists once a run settles, so the operator causes one by sending
   * a chat message while the runner waits. Polling faster than the client does is
   * what makes the measurement possible at all: the reply is on screen the instant
   * the notice appears, and the client would otherwise report it as seen within a
   * second or two, leaving nothing to stage.
   */

  /** Turn number a notice points at, or null when its reference is unusable. */
  const noticeTurn = (notice) => {
    const turn = Number(notice.targetTurnRef)
    return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
  }

  /**
   * The notices whose turn has a rendered `assistant-step`, measured.
   *
   * No "(any item)" fallback: a turn with no result kind rendered has no result
   * to measure, and letting its user row or a tool row stand in would hand A2 a
   * "reply" the page never drew.
   */
  const renderedResultNotices = (notices) => notices
    .map((notice) => ({ notice, turn: noticeTurn(notice) }))
    .filter((entry) => entry.turn !== null)
    .map((entry) => ({ notice: entry.notice, turn: entry.turn, state: measure(entry.turn) }))
    .filter((entry) => entry.state.answerItems.length > 0 && entry.state.groupKind === 'assistant-step')

  /**
   * Those of them that could hold the **whole** below-fold counterexample.
   *
   * A2 asks for two things at once: the reply strictly off the band, and a row of
   * the same turn still on it. A notice can satisfy the first and not the second —
   * a turn whose only non-result rows are hidden process rows and the `turn-tail`
   * beneath the reply has nothing left to show once the reply leaves — and a run
   * spent on such a notice is spent on a scenario that cannot be built. Both halves
   * are therefore part of what the waiter waits for.
   */
  const storableNotices = (notices) => renderedResultNotices(notices)
    .filter((entry) => entry.state.belowFold !== null && entry.state.belowFold.stageable)
    .filter((entry) => entry.state.stagedOtherOverlap !== null && entry.state.stagedOtherOverlap > 0)

  /** Why one candidate cannot hold the counterexample, in one line. */
  const refusalReason = (entry) => {
    const facts = entry.state.belowFold
    if (facts === null) return 'the reply could not be measured'
    if (!facts.stageable) return describeBelowFold(facts)
    const other = entry.state.stagedOtherOverlap
    if (other === null) {
      return 'stageable, but the turn has no other row to leave on screen'
        + ` (other rows: ${entry.state.otherKinds.join(', ') || 'none rendered'})`
    }
    if (other <= 0) {
      return `stageable, but every other row of the turn would leave the band too`
        + ` (projected other-row overlap=${px(other)}, other rows: ${entry.state.otherKinds.join(', ') || 'none rendered'})`
    }
    return `stageable, and ${entry.state.otherKinds.join(', ')} would stay ${px(other)}px inside the band`
  }

  /**
   * Poll until a notice that can hold the whole below-fold counterexample exists.
   *
   * Returning on the first unconfirmed notice was a live-run trap. The first
   * notice a fresh conversation mints points at turn 1, whose reply has only the
   * system prompt and the opening user row above it; pushing that reply below the
   * band needs a *negative* `scrollTop`, so A2 can never be staged on it and a
   * whole 480 s wait is spent on a scenario that cannot be built (ROUND 5's
   * `requiredScrollTop=-821`, `clampedTo=0`). Waiting for a usable one costs
   * nothing when the first notice is already usable, and otherwise keeps the
   * window open for the next turn — while saying, at most every 15 s, exactly
   * which notices it is refusing and why.
   *
   * @param sessionId - session to poll for.
   * @param timeoutMs - how long to keep polling; 0 means "look once".
   * @returns the last payload seen and the usable entries in it.
   */
  const waitForStorableNotice = async (sessionId, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let payload = await getNotices(sessionId)
    /* Report the refusals straight away, then at most every 15 s. */
    let nextReport = 0
    for (;;) {
      const usable = storableNotices(payload.notices)
      if (usable.length > 0) return { payload, usable }
      if (Date.now() >= deadline) return { payload, usable: [] }
      if (Date.now() >= nextReport) {
        nextReport = Date.now() + 15000
        const offered = renderedResultNotices(payload.notices).map((entry) =>
          `turn ${String(entry.notice.targetTurnRef)} (${String(entry.state.groupKind)}): ${refusalReason(entry)}`)
        log(`still waiting for a notice that can hold the below-fold counterexample`
          + ` (${Math.round((deadline - Date.now()) / 1000)} s left): `
          + (offered.length === 0
            ? 'none offered yet — cause a run by sending a chat message'
            : `refusing ${offered.join(' | ')}`))
      }
      await sleep(400)
      payload = await getNotices(sessionId)
    }
  }

  /* ================================================================= setup */
  log('================ environment ================')
  log('runner     ', RUNNER_VERSION)
  log('url        ', location.href)
  log('visibility ', document.visibilityState, '| hasFocus', document.hasFocus())
  log('tab-id     ', sessionStorage.getItem('dsh-pet-seen:tab-id')
    ?? '(absent -> the client half never ran in this tab; hard-refresh and re-paste)')
  log('activeRoots', document.querySelectorAll(ACTIVE_SELECTOR).length,
    '| flow', flow !== null, '| scroll', scroll !== null)

  record('A0-selectors',
    flow !== null && scroll !== null ? 'PASS' : 'FAIL',
    `flow=${flow !== null} scroll=${scroll !== null} activeRoots=${document.querySelectorAll(ACTIVE_SELECTOR).length}`)

  const rows = flowItems()
  const turns = [...new Set(rows.map((row) => turnOf(row)).filter((turn) => turn !== null))]
  log('turns rendered:', turns.length === 0 ? '(none)' : turns.join(', '))

  const kindsSeen = new Set(rows.map((element) => element.getAttribute(KIND_ATTRIBUTE)).filter(Boolean))
  record('A0-kinds',
    kindsSeen.size > 0 ? 'PASS' : 'FAIL',
    `data-chat-flow-kind values on rendered items: ${[...kindsSeen].sort().join(', ') || '(none)'}`)

  log('================ geometry per turn ================')
  for (const turn of turns) {
    const state = measure(turn)
    log(`turn ${turn}:`, {
      items: state.itemCount,
      kinds: state.kinds,
      resultGroup: state.groupKind,
      resultOverlap: px(state.groupOverlap),
      resultHeight: state.groupHeight,
      otherRowOverlap: px(state.otherOverlap),
      firstMatchOverlap: px(state.legacyOverlap),
      firstMatchHeight: state.legacyHeight,
    })
  }

  /* D1 premise: the first match is not the reply. */
  const d1Turn = turns.find((turn) => {
    const state = measure(turn)
    return state.answerItems.length > 0 && state.legacyBox !== null && state.groupHeight > state.legacyHeight * 2
  })
  if (d1Turn === undefined) {
    record('A1-first-match-is-not-the-reply', 'SKIP',
      'no rendered turn where the assistant-step group is clearly taller than the first [data-chat-turn] match')
  } else {
    const state = measure(d1Turn)
    record('A1-first-match-is-not-the-reply', 'PASS',
      `turn ${d1Turn}: first match h=${state.legacyHeight}px, assistant-step group h=${state.groupHeight}px (${state.answerItems.length} item(s))`)
  }

  /* ------------------------------------------- identify the current session */

  /*
   * The client posts its session id on `focus`/`visibilitychange` regardless of
   * whether the window is focused, so a synthetic focus event makes it identify
   * itself even while DevTools holds focus.
   */
  log('================ session discovery ================')
  window.dispatchEvent(new Event('focus'))
  let sessionId = null
  for (let attempt = 0; attempt < 16 && sessionId === null; attempt += 1) {
    await sleep(250)
    sessionId = sniffedSessionId()
  }

  if (sessionId === null) {
    record('A-discover-session', 'FAIL',
      'the client half never identified a session. Is this tab running the current bundle? Hard-refresh (Ctrl+Shift+R) and paste again.')
    log('SUMMARY', JSON.stringify(checks, null, 2))
    window.__petAccept = { sessionId, requests: sniffed, checks, chooseTarget, target: null }
    return
  }
  record('A-discover-session', 'PASS', `client reports session ${sessionId}`)

  log('')
  log('>>>>>>>>>>>>>>>>>>  CLICK ON THE PAGE NOW  <<<<<<<<<<<<<<<<<<')
  log('Console focus means hasFocus=false and L3 can never fire.')
  log('Gate A needs an UNCONFIRMED notice whose reply can be staged below the')
  log('fold. If there is none, keep this page focused and send a chat message; the')
  log(`runner waits ${Math.round(WAIT_FOR_NOTICE_MS / 1000)} s for one, and refuses any notice`)
  log('whose target turn has too little room above its reply.')
  log('')
  await sleep(CLICK_GRACE_MS)
  log('page focus check:', document.visibilityState, '| hasFocus', document.hasFocus())

  const waited = await waitForStorableNotice(sessionId, WAIT_FOR_NOTICE_MS)
  const before = waited.payload
  record('Y0-notices-route', before.ok ? 'PASS' : 'FAIL', `GET /pet-bridge/notices -> ${before.status}`)
  log('notices payload:', JSON.stringify(before.notices, null, 2))

  const shownNotices = before.notices.filter((notice) => notice.state === 'shown')
  record('Y1-shown-is-still-offered',
    before.notices.length === 0 ? 'SKIP' : (shownNotices.length > 0 ? 'PASS' : 'INFO'),
    before.notices.length === 0
      ? 'no unconfirmed notice for this session, so D2 cannot be exercised here'
      : `${before.notices.length} notice(s), ${shownNotices.length} already displayed by the pet (state="shown")`)

  const dwellMs = before.seenDwellMs ?? DWELL_FALLBACK_MS
  log(`dwell advertised by the host: ${dwellMs} ms`)

  /* --------------------------------------------------------- pick a target */

  /*
   * When the wait found a storable notice, that is the candidate pool. When it ran
   * out of time, fall back to every rendered-result notice so the report names the
   * geometry that made each one unusable instead of claiming no notice existed.
   */
  const candidates = waited.usable.length > 0 ? waited.usable : renderedResultNotices(before.notices)

  if (candidates.length === 0) {
    // Both gates are recorded as unproven: a missing check must never read as a
    // passing one, and A3 cannot run without a staged target either.
    const reason = 'no notice whose target turn has a rendered assistant-step; nothing to stage'
    record('A2-counterexample', 'SKIP', reason)
    record('A3-gate-a', 'SKIP', reason)
    log('SUMMARY', JSON.stringify(checks, null, 2))
    /*
     * `sessionId` belongs in every published handle. Leaving it out of this early
     * return made the driver's own `DRIVER-session-matches` check report
     * `page is on undefined` — a false failure that said nothing about the page
     * and sent the reader looking for a session mismatch that had not happened.
     */
    window.__petAccept = { sessionId, requests: sniffed, checks, chooseTarget, target: null }
    return
  }

  candidates.sort((left, right) => right.turn - left.turn)
  const target = chooseTarget(candidates)

  /*
   * The gates may only ever be judged against the turn the notice itself points
   * at. The page picks its observee from `notice.targetTurnRef`, so a mismatch
   * between the notice and the measured turn would mean the verdict describes a
   * turn nobody was notified about — a pass resting on evidence that does not
   * belong to the notice. Assert the identity rather than trusting it, and
   * publish the quadruple so the report can be tied back to one notice without
   * reading the console log.
   */
  const quadruple = {
    noticeId: target.notice.noticeId,
    runId: target.notice.runId ?? null,
    sessionId: target.notice.sessionId ?? null,
    targetTurnRef: target.notice.targetTurnRef ?? null,
  }
  record('A0-target-quadruple',
    quadruple.sessionId === sessionId && quadruple.targetTurnRef === String(target.turn) ? 'PASS' : 'FAIL',
    `notice ${quadruple.noticeId} (run ${String(quadruple.runId)}, session ${String(quadruple.sessionId)},`
    + ` turn ${String(quadruple.targetTurnRef)}) judged against page session ${sessionId} and staged turn ${target.turn}`)
  const stageableCount = candidates.filter((entry) =>
    entry.state.belowFold !== null && entry.state.belowFold.stageable).length
  const why = stageableCount > 0
    ? `${stageableCount} of ${candidates.length} candidate(s) can be staged below the fold`
    : `none of ${candidates.length} candidate(s) can be staged below the fold`
  log(`watching notice ${target.notice.noticeId} (turn ${target.turn}, state ${target.notice.state}) — ${why}`)
  log(`target below-fold facts: ${JSON.stringify(target.state.belowFold)}`)
  if (candidates.length > 1) {
    log('candidates: ' + JSON.stringify(candidates.map((entry) => ({
      turn: entry.turn,
      state: entry.state.groupKind,
      height: entry.state.groupHeight,
      overlap: px(entry.state.groupOverlap),
      stageable: entry.state.belowFold === null ? null : entry.state.belowFold.stageable,
      willClamp: entry.state.belowFold === null ? null : entry.state.belowFold.willClamp,
      needed: entry.state.belowFold === null ? null : px(entry.state.belowFold.requiredScrollTop),
      max: entry.state.belowFold === null ? null : px(entry.state.belowFold.maxScrollTop),
      roomAboveShort: entry.state.belowFold === null ? null : px(entry.state.belowFold.roomAboveShort),
      pastContentEnd: entry.state.belowFold === null ? null : px(entry.state.belowFold.pastContentEnd),
    }))))
    for (const entry of candidates) {
      log(`candidate turn ${entry.turn} (${String(entry.state.groupKind)}): ${describeBelowFold(entry.state.belowFold)}`)
    }
  }

  /* ------------------------------------------------ A2: the counterexample */

  const stageNegative = await stageReplyBelowFold(target.turn)
  await sleep(SETTLE_MS)
  const negative = measure(target.turn)
  log(`staged below-fold: result overlap=${px(negative.groupOverlap)} otherRowOverlap=${px(negative.otherOverlap)}`
    + ` group=${String(negative.groupKind)} hasFocus=${document.hasFocus()}`)

  /*
   * What the plan actually asks for is a *specific* geometry: some other row of
   * the same turn is on screen while the reply is not (PLAN-ROUND2 §3.1: "只有
   * turn 头部或其他行可见、正文未出现时不应取消"). Two weaker situations must
   * never be reported as PASS:
   *
   *   1. the reply still overlaps the band — even by a fraction of a pixel;
   *   2. nothing of the turn is on screen at all, which only proves that an
   *      off-screen conversation is not observed.
   *
   * Both are recorded as SKIP, which `tools/cdp-acceptance.mjs` turns into an
   * INCOMPLETE verdict rather than a green run.
   */
  const replyOffScreen = negative.groupOverlap !== null && negative.groupOverlap < 0
  const otherRowOnScreen = negative.otherOverlap !== null && negative.otherOverlap > 0

  if (!stageNegative.staged) {
    const facts = negative.belowFold
    record('A2-counterexample', 'SKIP',
      `the reply could not be staged below the fold: ${stageNegative.reason}`
      + (facts === null || stageNegative.reason.indexOf('vs band') !== -1
        ? ''
        : ` [${describeBelowFold(facts)}]`))
  } else if (negative.groupKind !== 'assistant-step') {
    record('A2-counterexample', 'SKIP',
      `the measured result group is "${String(negative.groupKind)}", not assistant-step,`
      + ' so this turn\'s reply is not what is being measured')
  } else if (!replyOffScreen) {
    record('A2-counterexample', 'SKIP',
      `the staging claimed the reply left the band, but it still overlaps by ${px(negative.groupOverlap)}px`
      + (stageNegative.clamped ? ' (the scroll was clamped)' : ' (the scroll was applied in full)')
      + ` [${describeBelowFold(negative.belowFold)}]`)
  } else if (!otherRowOnScreen) {
    record('A2-counterexample', 'SKIP',
      `the reply is off screen but no other row of turn ${target.turn} is on screen either`
      + ` (other-row overlap=${px(negative.otherOverlap)}, other rows: ${negative.otherKinds.join(', ') || '(none rendered)'})`
      + ' — that is a weaker variant which cannot prove the D1 rule')
  } else {
    const beforePosts = seenPostsFor(target.notice.noticeId).length
    const holdMs = dwellMs + HOLD_EXTRA_MS
    log(`holding below-fold for ${holdMs} ms ...`)
    /*
     * Poll while holding, for two reasons. The reply has to stay off screen, and
     * the pet is expected to acknowledge the popup as `shown` part-way through
     * this window — a `shown` notice that is *still listed* is D2 working. The
     * old `pendingFor()` dropped it at exactly that point, so the page lost the
     * notice and the popup could never be retracted.
     */
    const holdUntil = Date.now() + holdMs
    let listed = true
    let shownWhileListed = false
    let stagingViolated = false
    let contextLost = false
    while (Date.now() < holdUntil) {
      /*
       * Re-assert the staging on every iteration. The chat anchors itself to the
       * newest content, and a re-anchor after the run settles would slide the
       * reply back into view — quietly turning this counterexample into an
       * ordinary look at the answer, which is exactly the kind of silent
       * mis-staging that makes a gate worthless.
       */
      await stageReplyBelowFold(target.turn)
      await sleep(Math.min(500, Math.max(0, holdUntil - Date.now())))
      const recheck = measure(target.turn)
      if (!(recheck.groupOverlap !== null && recheck.groupOverlap < 0)) stagingViolated = true
      if (!(recheck.otherOverlap !== null && recheck.otherOverlap > 0)) contextLost = true
      const poll = await getNotices(sessionId)
      const mine = poll.notices.find((notice) => notice.noticeId === target.notice.noticeId)
      if (mine === undefined) { listed = false; break }
      if (mine.state === 'shown') shownWhileListed = true
    }
    const afterPosts = seenPostsFor(target.notice.noticeId)
    record('Y2-shown-survives-delivery',
      shownWhileListed ? 'PASS' : 'SKIP',
      shownWhileListed
        ? 'the pet acknowledged the popup as "shown" and the notice was still offered to the page (D2)'
        : 'the notice never reached state "shown" during the hold; run the mock pet with --ack-shown to exercise D2')
    if (!document.hasFocus()) {
      record('A2-counterexample', 'INCONCLUSIVE',
        `page did not hold focus during the hold, so L3 could not run either way (new /seen posts=${afterPosts.length - beforePosts})`)
    } else if (stagingViolated) {
      record('A2-counterexample', 'INCONCLUSIVE',
        'the page slid the reply back into view during the hold, so the reply was not continuously off screen and the counterexample was never held')
    } else if (contextLost) {
      record('A2-counterexample', 'INCONCLUSIVE',
        'the reply stayed off screen but the rest of the turn left the band, so the counterexample geometry was not held')
    } else {
      record('A2-counterexample',
        afterPosts.length === beforePosts && listed ? 'PASS' : 'FAIL',
        `reply off screen for ${dwellMs + HOLD_EXTRA_MS} ms while ${negative.otherKinds.join(', ') || 'another row'} stayed on screen:`
        + ` new /seen posts=${afterPosts.length - beforePosts}, notice still listed=${listed}`)
    }
  }

  /* ------------------------------------------------------- A3: gate A */

  /*
   * Gate A can only be proven from a notice that was still unobserved, and whose
   * reply was still off screen, at the moment this phase begins. Two ways that
   * starting state is already gone, and both used to be reported as a product
   * failure:
   *
   *   1. this tab already posted `/seen` for the notice. A later report then
   *      cannot be attributed to the dwell this phase measures, because the
   *      report that "went missing" happened before the baseline was taken.
   *      ROUND 5 run 3 logged exactly this shape — a `/seen` for the right
   *      notice, and a baseline counted after it — and the zero that followed
   *      read like a dead client.
   *   2. A2 did not hold its counterexample, so A2's own scrolling left the reply
   *      inside the band and the page may already have been dwelling on it. The
   *      plan forbids reusing a notice that A2's staging already exposed.
   *
   * Neither is a product failure and neither may be reported as one: the phase is
   * skipped, naming which half of the starting state was missing. A fresh notice
   * is what fixes it, not a weaker gate.
   */
  const seenBeforeA3 = seenPostsFor(target.notice.noticeId)
  const pollAtA3 = await getNotices(sessionId)
  const noticeAtA3 = pollAtA3.notices.find((notice) => notice.noticeId === target.notice.noticeId) ?? null
  const a2Verdict = checks.find((check) => check.id === 'A2-counterexample')?.verdict ?? 'MISSING'

  if (seenBeforeA3.length > 0) {
    log('the client already reported this notice; not reusing it for the positive stage')
    record('A3-gate-a', 'SKIP',
      `this tab had already posted /seen for the notice ${seenBeforeA3.length} time(s) before the positive`
      + ' stage began, so a later report could not be attributed to the dwell this phase measures')
  } else if (noticeAtA3 === null) {
    record('A3-gate-a', 'SKIP',
      'the notice stopped being offered to the page before the positive stage began (retired elsewhere or'
      + ' settled), so there was nothing left here to confirm')
  } else if (a2Verdict !== 'PASS') {
    record('A3-gate-a', 'SKIP',
      `the below-fold counterexample was not held (A2=${a2Verdict}), so the reply was inside the band before`
      + ' this phase and the notice may already have been dwelling; re-run against a notice whose turn can be'
      + ' staged below the fold')
  } else {
    /*
     * Park the reply off screen again before the baseline. A2 held this geometry,
     * so this normally only re-asserts the scroll after A2's settle; but the
     * dwell clock must provably not be running when the baseline is taken, or the
     * next report cannot be attributed to the positive stage. If the reply will
     * not stay out of the band, this phase cannot measure from a known state and
     * says so rather than guessing.
     */
    const reasserted = await stageReplyBelowFold(target.turn)
    await sleep(SETTLE_MS)
    const atBaseline = measure(target.turn)
    const offScreenAtBaseline = atBaseline.groupOverlap !== null && atBaseline.groupOverlap < 0
    if (!reasserted.staged || !offScreenAtBaseline) {
      record('A3-gate-a', 'SKIP',
        'the reply could not be parked off screen before the baseline, so the dwell that the positive stage'
        + ` would measure cannot be told apart from one already running (result overlap=${px(atBaseline.groupOverlap)})`)
    } else {
      /*
       * The baseline: the number of reports this tab has made for this notice, and
       * the host's state for it, captured with the reply still out of the band.
       * Everything between here and the verdict is the positive stage.
       */
      const baselinePosts = seenBeforeA3.length
      const baselineState = noticeAtA3.state
      log(`A3 baseline: notice state=${baselineState}, /seen posts from this tab=${baselinePosts},`
        + ` result overlap=${px(atBaseline.groupOverlap)}`)

      const stagePositive = stageReplyInView(target.turn)
      await sleep(SETTLE_MS)
      const positive = measure(target.turn)
      log(`staged in-view: result overlap=${px(positive.groupOverlap)} hasFocus=${document.hasFocus()}`)

      if (!stagePositive.staged || positive.groupOverlap === null || positive.groupOverlap <= 0) {
        record('A3-gate-a', 'SKIP', 'could not stage the reply inside the visible band')
      } else {
        log(`holding in-view for ${dwellMs + HOLD_EXTRA_MS} ms ...`)
        await sleep(dwellMs + HOLD_EXTRA_MS)
        const fresh = seenPostsFor(target.notice.noticeId).slice(baselinePosts)
        const after = await getNotices(sessionId)
        const stillListed = after.notices.some((notice) => notice.noticeId === target.notice.noticeId)
        const stateAfter = after.notices.find((notice) => notice.noticeId === target.notice.noticeId)?.state
          ?? baselineState
        /*
         * The three pieces of evidence are kept apart on purpose. A report from
         * this tab is the only thing the page can claim; the host's acceptance is
         * the only thing that makes it an observation; and the notice leaving the
         * list is what the plan asks for as the terminal state. A pass needs the
         * report and the terminal state, and no refusal in between.
         */
        const refused = fresh.filter((entry) => entry.status !== null && (entry.status < 200 || entry.status >= 300))
        const denied = fresh.filter((entry) => entry.accepted === false)
        if (!document.hasFocus()) {
          record('A3-gate-a', 'INCONCLUSIVE',
            `page did not hold focus during the hold (new /seen posts=${fresh.length})`)
        } else if (refused.length > 0) {
          record('A3-gate-a', 'FAIL',
            `this tab posted /seen and the host refused it: HTTP ${refused.map((entry) => entry.status).join(', ')}`)
        } else if (denied.length > 0) {
          record('A3-gate-a', 'FAIL',
            'this tab posted /seen and the host answered accepted=false, so the observation was thrown away')
        } else if (fresh.length > 0 && !stillListed) {
          record('A3-gate-a', 'PASS',
            `reply on screen for ${dwellMs + HOLD_EXTRA_MS} ms from a baseline of ${baselinePosts} post(s):`
            + ` new /seen posts=${fresh.length} (HTTP ${fresh.map((entry) => entry.status ?? '?').join(', ')}),`
            + ` notice "${baselineState}" is no longer offered to the page`)
        } else if (fresh.length > 0) {
          record('A3-gate-a', 'FAIL',
            `this tab posted /seen ${fresh.length} time(s) but the notice is still offered to the page`
            + ` (state "${stateAfter}"), so the host did not act on the observation`)
        } else if (!stillListed) {
          record('A3-gate-a', 'INCONCLUSIVE',
            'no report came from this tab, yet the notice stopped being offered: another consumer retired it,'
            + ' which says nothing about this page\'s dwell')
        } else {
          record('A3-gate-a', 'FAIL',
            `reply on screen for ${dwellMs + HOLD_EXTRA_MS} ms from a clean baseline of ${baselinePosts} post(s):`
            + ` new /seen posts=0 and the notice is still offered (state "${stateAfter}")`)
        }
      }
    }
  }

  /* ------------------------------------------------------------- summary */

  log('================ client requests observed ================')
  for (const entry of sniffed) log(' ', entry.method, entry.url, entry.body === null ? '' : entry.body.slice(0, 160))

  const failed = checks.filter((check) => check.verdict === 'FAIL')
  const inconclusive = checks.filter((check) => check.verdict === 'INCONCLUSIVE' || check.verdict === 'SKIP')
  log('================ SUMMARY ================')
  for (const check of checks) log(`${check.verdict.padEnd(13)} ${check.id}`)
  log(failed.length === 0
    ? `OVERALL: no FAIL (${inconclusive.length} inconclusive/skipped)`
    : `OVERALL: ${failed.length} FAIL -> ${failed.map((check) => check.id).join(', ')}`)

  window.__petAccept = {
    sessionId,
    checks,
    requests: sniffed,
    /*
     * Published so the target-selection rule can be tested directly. A page
     * scene cannot tell "newest wins" from "stageable wins" apart when the newest
     * candidate is also the stageable one, which is the usual case.
     */
    chooseTarget,
    /** The notice this run was judged against: noticeId, runId, sessionId, targetTurnRef. */
    target: quadruple,
    stop: () => { window.fetch = originalFetch },
  }
  log('window.__petAccept holds { sessionId, checks, requests, target }.')
})()
