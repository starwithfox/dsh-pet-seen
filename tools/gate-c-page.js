/**
 * Gate C page side: the observation primitives, injected verbatim by
 * `tools/cdp-gate-c.mjs`.
 *
 * Gate A (see `acceptance-client-page.js`) proves the rule *inside one session*:
 * a reply that is off the band is not observed, and the same reply on the band
 * is. Gate C asks the harder, cross-cutting questions the plan lists in §3.6 and
 * §3.7, all of which need two tabs of the same browser and per-tab focus
 * control:
 *
 *   1. another session — a notice for session B must not be confirmed while the
 *      focused tab is showing session A, however long B's reply has been on
 *      B's screen (the tab is not even visible then);
 *   2. blurred — the tab is visible but the window is not focused;
 *   3. mismatched turn — the notice points at turn X while turn Y's reply is
 *      the one on screen;
 *   4. multiple notices in one session — an older, off-screen result must not
 *      vouch for a newer notice, and must not be blocked by it either;
 *   5. `dismissed` — a popup the user closed must not be rebuilt, and looking at
 *      the result again must not confirm it.
 *
 * This file deliberately answers only "what is true right now" (geometry,
 * focus, which requests the page made, what the host offers). The verdicts live
 * in the driver, derived from the raw observations it records, because the
 * sequence of tab activations and focus toggles is the driver's to control and
 * a page-side verdict would have to guess when it was allowed to conclude.
 *
 * Injected as an expression, so it must stay self-contained: no imports, no
 * top-level await, everything inside the IIFE.
 *
 * @module tools/gate-c-page
 */

(() => {
  const GATE_C_VERSION = 'gate-c-2'
  const TAG = '[pet-gate-c]'
  const log = (...parts) => console.log(TAG, ...parts)

  const config = (typeof window !== 'undefined' && window.__petGateCConfig !== null
    && typeof window.__petGateCConfig === 'object') ? window.__petGateCConfig : {}
  const tuned = (name, fallback) => (typeof config[name] === 'number' ? config[name] : fallback)
  const SETTLE_MS = tuned('settleMs', 400)
  const DWELL_FALLBACK_MS = tuned('dwellFallbackMs', 1500)

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /* ---------------------------------------------------------- fetch sniffer */

  /*
   * Installed before anything else, and never removed: every phase is measured
   * from the requests the *page* made, so a report written by the driver has to
   * carry the same evidence the client produced. A second injection (the driver
   * re-evaluates nothing here, but a human can paste this file again) unwraps the
   * previous layer first, or every request would be counted once per layer.
   */
  try { window.__petGateC?.stop?.() } catch { /* nothing to unwind */ }

  const originalFetch = window.fetch.bind(window)
  /** @type {Array<{url: string, method: string, body: string|null, at: number, status: number|null, accepted: boolean|null}>} */
  let sniffed = []
  window.fetch = function (input, init) {
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
     * The host's answer is recorded without touching the promise the client
     * awaits: "the page posted /seen" and "the host accepted the observation"
     * are different facts, and only the second one retires a notice.
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
          } catch { /* cloned body unavailable */ }
        }, () => { /* the request itself failed; the count still stands */ })
      } catch { /* not a thenable */ }
    }
    return result
  }

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

  /** The visible band of the scroll container, clipped to the viewport. */
  const band = () => {
    const viewportTop = 0
    const viewportBottom = window.innerHeight
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
   * Signed overlap of a box with the band, unrounded.
   *
   * Rounding was a real defect in the Gate A runner: a 0.4 px overlap became a
   * clean zero and read as "off screen". The shipping visibility test compares
   * raw numbers, so the measurement has to as well.
   */
  const overlap = (box) => {
    if (box === null) return null
    const visible = band()
    return Math.min(box.bottom, visible.bottom) - Math.max(box.top, visible.top)
  }

  const px = (value) => (value === null || value === undefined ? value : Math.round(value))

  const contentY = (viewportY) => {
    if (scroll === null || scroll === undefined) return viewportY
    return viewportY - scroll.getBoundingClientRect().top + scroll.scrollTop
  }

  const maxScrollTop = () => {
    if (scroll === null || scroll === undefined) return 0
    return Math.max(0, (scroll.scrollHeight ?? 0) - (scroll.clientHeight ?? 0))
  }

  /** Everything the driver needs about one turn, as plain JSON. */
  const snapshot = (turn) => {
    const items = flowItems().filter((element) => turnOf(element) === turn)
    let groupBox = null
    let groupKind = null
    for (const kind of RESULT_KINDS) {
      const box = unionBox(items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) { groupBox = box; groupKind = kind; break }
    }
    const otherItems = items.filter((element) => !RESULT_KINDS.includes(element.getAttribute(KIND_ATTRIBUTE)))
    const otherBox = unionBox(otherItems)
    const visible = band()
    return {
      turn,
      rendered: items.length > 0,
      itemCount: items.length,
      groupKind,
      groupHeight: groupBox === null ? 0 : Math.round(groupBox.bottom - groupBox.top),
      groupOverlap: px(overlap(groupBox)),
      groupTop: groupBox === null ? null : px(groupBox.top),
      otherOverlap: px(overlap(otherBox)),
      otherKinds: otherItems.map((element) => element.getAttribute(KIND_ATTRIBUTE)),
      bandTop: px(visible.top),
      bandBottom: px(visible.bottom),
      bandHeight: Math.max(0, Math.round(visible.bottom - visible.top)),
    }
  }

  const scrollToContentY = (y) => {
    if (scroll === null || scroll === undefined) return { moved: false, clamped: false }
    const max = maxScrollTop()
    const wanted = Math.round(y)
    const applied = Math.max(0, Math.min(max, wanted))
    scroll.scrollTop = applied
    return { moved: true, clamped: applied !== wanted, wanted, applied }
  }

  /**
   * Scroll so the turn's reply fills the top of the band (the "observed" state).
   *
   * @param turn - the turn whose reply must be inside the band.
   * @returns the move plus the geometry after it settled.
   */
  const parkInBand = async (turn) => {
    const visible = band()
    const height = visible.bottom - visible.top
    const before = snapshot(turn)
    const items = flowItems().filter((element) => turnOf(element) === turn)
    let box = null
    for (const kind of RESULT_KINDS) {
      box = unionBox(items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) break
    }
    if (box === null) return { staged: false, clamped: false, before, after: before, reason: 'no result kind rendered' }
    /* The *result* box, not the whole turn: the turn's own tail sits below it. */
    const move = scrollToContentY(contentY(box.top) - height * 0.15)
    if (!move.moved) return { staged: false, clamped: false, before, after: before, reason: 'no scroll container' }
    await sleep(SETTLE_MS)
    const after = snapshot(turn)
    const staged = after.groupOverlap !== null && after.groupOverlap > 0
    return { staged, clamped: move.clamped, wanted: move.wanted, applied: move.applied, before, after, reason: staged ? '' : 'the reply did not land inside the band' }
  }

  /**
   * Scroll so the turn's reply is strictly off the band.
   *
   * `direction: 'below'` scrolls *up* (the wanted position is
   * `contentY(top) - bandHeight - margin`), which is what the Gate A
   * counterexample uses and what keeps the rows above the reply on screen.
   * `direction: 'above'` scrolls *down* past the reply instead, which is the only
   * option for a turn near the start of the conversation, where there is no room
   * above. The caller is told which one succeeded.
   *
   * @param turn - the turn whose reply must leave the band.
   * @param direction - `'below'` (default), `'above'`, or `'either'`.
   * @returns the move, the direction actually taken, and the geometry after it.
   */
  const parkOffBand = async (turn, direction = 'either') => {
    const visible = band()
    const height = visible.bottom - visible.top
    const margin = tuned('offBandMarginPx', 16)
    const items = flowItems().filter((element) => turnOf(element) === turn)
    let box = null
    for (const kind of RESULT_KINDS) {
      box = unionBox(items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) break
    }
    const before = snapshot(turn)
    if (box === null) return { staged: false, clamped: false, direction: null, before, after: before, reason: 'no result kind rendered' }
    const wanted = {
      below: contentY(box.top) - height - margin,
      above: contentY(box.bottom) + margin,
    }
    const order = direction === 'below' ? ['below'] : (direction === 'above' ? ['above'] : ['below', 'above'])
    let move = null
    let taken = null
    for (const candidate of order) {
      move = scrollToContentY(wanted[candidate])
      await sleep(SETTLE_MS)
      const after = snapshot(turn)
      if (after.groupOverlap !== null && after.groupOverlap < 0) {
        return {
          staged: true,
          clamped: move.clamped,
          direction: candidate,
          margin,
          wanted: wanted[candidate],
          applied: move.applied,
          before,
          after,
          reason: '',
        }
      }
      taken = candidate
    }
    const after = snapshot(turn)
    return {
      staged: false,
      clamped: move === null ? false : move.clamped,
      direction: taken,
      margin,
      wanted: taken === null ? null : wanted[taken],
      applied: move === null ? null : move.applied,
      before,
      after,
      reason: 'the reply stayed inside the band in every direction tried',
    }
  }

  /**
   * Scroll so the turn's reply starts at the **top** of the band.
   *
   * `parkInBand()` leaves the last 15 % of the band showing whatever came before,
   * which is fine when the question is "is this reply on screen" but wrong when
   * the question is "which notice is the page looking at". The client picks the
   * oldest *visible* candidate (`selectWatchTarget`), so a sliver of the previous
   * turn's reply on screen is enough for the page to watch that turn's notice
   * instead — and the answer to "was the reply I parked confirmed?" would then be
   * about a different notice entirely. Aligning the reply's top with the band's
   * top leaves every earlier turn strictly above it.
   *
   * @param turn - the turn whose reply must own the band.
   * @returns the move plus the geometry after it settled.
   */
  const parkAtBandTop = async (turn) => {
    const visible = band()
    const items = flowItems().filter((element) => turnOf(element) === turn)
    let box = null
    for (const kind of RESULT_KINDS) {
      box = unionBox(items.filter((element) => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) break
    }
    const before = snapshot(turn)
    if (box === null) return { staged: false, clamped: false, before, after: before, reason: 'no result kind rendered' }
    /*
     * Wanted viewport position: `visible.top + bite`, i.e. the reply's top edge a
     * few pixels *inside* the band so rounding cannot leave it exactly on the edge.
     * `contentY()` already accounts for the container, so the scroll position is
     * `contentY(top) - wanted + containerTop`.
     */
    const containerTop = scroll === null || scroll === undefined ? 0 : scroll.getBoundingClientRect().top
    const bite = tuned('bandTopBitePx', 8)
    const move = scrollToContentY(contentY(box.top) - visible.top + containerTop - bite)
    if (!move.moved) return { staged: false, clamped: false, before, after: before, reason: 'no scroll container' }
    await sleep(SETTLE_MS)
    const after = snapshot(turn)
    const staged = after.groupOverlap !== null && after.groupOverlap > 0
    return {
      staged,
      clamped: move.clamped,
      wanted: move.wanted,
      applied: move.applied,
      before,
      after,
      reason: staged ? '' : 'the reply did not land inside the band',
    }
  }

  /**
   * Bring a turn into the DOM.
   *
   * `[data-chat-turn]` is virtualised: only the turns near the viewport exist, so
   * a notice pointing at turn 2 cannot be parked before turn 2 has been rendered
   * at all. This walks the container towards the wanted turn and stops as soon as
   * it appears, which is the difference between "the notice has no rendered
   * result" and "nobody scrolled there yet".
   *
   * It jumps to the **top** before walking. Walking up from the bottom one
   * band-sized step at a time was measured live and does not work: the
   * conversation anchors itself to the newest content while the reader is at the
   * bottom, so turn 2 of a three-turn session was still not reached after forty
   * steps. `scrollTop = 0` is also what tells the harness the reader has left the
   * bottom, which is what stops that anchoring.
   *
   * @param turn - the turn that must be rendered.
   * @param maxSteps - how many steps to try after the jump.
   * @returns whether it was found, how, and what was rendered along the way.
   */
  const revealTurn = async (turn, maxSteps = 60) => {
    const renderedTurns = () =>
      [...new Set(flowItems().map((element) => turnOf(element)).filter((each) => each !== null))].sort((a, b) => a - b)
    const present = () => flowItems().some((element) => turnOf(element) === turn)
    /** Last few steps only: enough to explain a failure without megabytes of JSON. */
    const trace = []
    const remember = (entry) => {
      trace.push(entry)
      if (trace.length > 12) trace.shift()
    }
    if (present()) return { found: true, steps: 0, strategy: 'already-rendered', renderedTurns: renderedTurns(), trace }
    if (scroll === null || scroll === undefined) {
      return { found: false, steps: 0, reason: 'no scroll container', renderedTurns: renderedTurns(), trace }
    }
    scroll.scrollTop = 0
    await sleep(SETTLE_MS)
    if (present()) return { found: true, steps: 1, strategy: 'jump-to-top', renderedTurns: renderedTurns(), trace }
    for (let step = 1; step <= maxSteps; step += 1) {
      const rendered = renderedTurns()
      if (rendered.length === 0) {
        return { found: false, steps: step, reason: 'no turn is rendered at all', renderedTurns: rendered, trace }
      }
      const lowest = rendered[0]
      const highest = rendered[rendered.length - 1]
      const visible = band()
      const stride = Math.max(120, Math.round((visible.bottom - visible.top) * 0.6))
      /* Inside the window but not rendered: keep moving on rather than giving up. */
      const delta = turn < lowest ? -stride : (turn > highest ? stride : Math.round(stride / 2))
      const before = scroll.scrollTop
      scroll.scrollTop = Math.max(0, Math.min(maxScrollTop(), before + delta))
      remember({ step, scrollTop: Math.round(scroll.scrollTop), rendered })
      await sleep(SETTLE_MS)
      if (present()) {
        return { found: true, steps: step + 1, strategy: 'walk-from-top', renderedTurns: renderedTurns(), trace }
      }
      if (Math.round(scroll.scrollTop) === Math.round(before)) {
        return {
          found: false,
          steps: step,
          reason: `reached the ${delta < 0 ? 'top' : 'bottom'} of the conversation and turn ${turn} is still not rendered`,
          renderedTurns: rendered,
          trace,
        }
      }
    }
    return { found: false, steps: maxSteps, reason: `gave up after ${maxSteps} steps`, renderedTurns: renderedTurns(), trace }
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

  /** Every `/seen` POST this tab made, optionally for one notice. */
  const seenPosts = (noticeId = null) => sniffed
    .filter((entry) => entry.url.indexOf('/pet-bridge/seen') !== -1 && entry.body !== null)
    .filter((entry) => noticeId === null || entry.body.indexOf(noticeId) !== -1)
    .map((entry) => ({ at: entry.at, status: entry.status, accepted: entry.accepted, body: entry.body }))

  /* ------------------------------------------------------------------- API */

  const state = () => {
    const visible = band()
    return {
      version: GATE_C_VERSION,
      href: location.href,
      visible: document.visibilityState,
      focused: document.hasFocus(),
      tabId: sessionStorage.getItem('dsh-pet-seen:tab-id'),
      scrollTop: scroll === null || scroll === undefined ? null : Math.round(scroll.scrollTop),
      maxScrollTop: px(maxScrollTop()),
      bandHeight: px(Math.max(0, visible.bottom - visible.top)),
      renderedTurns: [...new Set(flowItems().map((element) => turnOf(element)).filter((turn) => turn !== null))].sort((a, b) => a - b),
      flow: flow !== null,
      scroll: scroll !== null && scroll !== undefined,
      seenPosts: seenPosts().length,
      requests: sniffed.length,
    }
  }

  /**
   * Re-announce focus, so the client re-posts its `/visibility` lease.
   *
   * A positive phase is only meaningful once the host holds an *effective* lease
   * for this tab: `/seen` is refused with `no-effective-lease` otherwise, and that
   * refusal would read as "the page failed to report" when in truth the lease had
   * simply lapsed. The client re-posts on `focus`/`visibilitychange` whatever the
   * real window focus is, which is what makes this work from an injected script.
   */
  const nudgeFocus = async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await sleep(SETTLE_MS)
    return { visible: document.visibilityState, focused: document.hasFocus() }
  }

  /**
   * The notice the driver should judge, out of the host's offer for this tab.
   *
   * Newest first is right here, unlike in the Gate A runner: every phase below
   * needs a *rendered* reply, and the newest turns are the ones the conversation
   * is anchored to. A notice whose turn has no rendered result is skipped and
   * named, so the report never silently picks a different one.
   */
  const chooseTarget = async (sessionId) => {
    const payload = await getNotices(sessionId)
    const considered = []
    for (const notice of payload.notices) {
      const turn = Number(notice.targetTurnRef)
      const rendered = Number.isSafeInteger(turn) ? snapshot(turn) : null
      considered.push({
        noticeId: notice.noticeId,
        turn: Number.isSafeInteger(turn) ? turn : null,
        state: notice.state,
        rendered: rendered !== null && rendered.rendered,
        groupKind: rendered === null ? null : rendered.groupKind,
        hasResult: rendered !== null && rendered.groupKind !== null,
      })
    }
    const usable = considered.filter((entry) => entry.hasResult)
    usable.sort((left, right) => right.turn - left.turn)
    return { payload: { ok: payload.ok, status: payload.status, seenDwellMs: payload.seenDwellMs }, considered, chosen: usable.length > 0 ? usable[0] : null, usable }
  }

  /**
   * Which notice the *client* will watch, out of the host's current offer.
   *
   * This is the mirror of `selectWatchTarget` (`src/client/decide.ts`), and it
   * exists because Gate C's first live run judged a positive phase against the
   * wrong notice: the driver parked the newest notice's reply as a 54 px sliver
   * at the bottom of the band, while the client — which watches the **oldest
   * visible** candidate — was watching an older reply that was genuinely on
   * screen and duly confirmed *that* notice. The phase then reported "the reply
   * was on screen for the dwell and nothing was confirmed", which is a statement
   * about a notice the page was never looking at.
   *
   * The order matters and is the host's: `/pet-bridge/notices` lists candidates
   * oldest completion first, and the client walks that list and takes the first
   * one whose result is on screen, falling back to the oldest candidate when
   * nothing is on screen (that fallback never accumulates dwell).
   *
   * @param sessionId - session whose offer should be mirrored.
   * @returns the per-candidate visibility, and the predicted watch target.
   */
  const watchMirror = async (sessionId) => {
    const payload = await getNotices(sessionId)
    const order = []
    for (const notice of payload.notices) {
      const turn = Number(notice.targetTurnRef)
      const measured = Number.isSafeInteger(turn) ? snapshot(turn) : null
      const onBand = measured !== null && measured.groupOverlap !== null && measured.groupOverlap > 0
      order.push({
        noticeId: notice.noticeId,
        turn: Number.isSafeInteger(turn) ? turn : null,
        state: notice.state,
        rendered: measured !== null && measured.rendered === true,
        overlap: measured === null ? null : measured.groupOverlap,
        visible: onBand,
      })
    }
    const visible = order.find((entry) => entry.visible) ?? null
    const fallback = order.length > 0 ? order[0] : null
    const predicted = visible ?? fallback
    return {
      ok: payload.ok,
      status: payload.status,
      seenDwellMs: payload.seenDwellMs,
      order,
      predicted: predicted === null
        ? null
        : { noticeId: predicted.noticeId, turn: predicted.turn, visible: predicted.visible },
    }
  }

  window.__petGateC = {
    version: GATE_C_VERSION,
    session: sniffedSessionId,
    state,
    watchMirror,
    turns: () => [...new Set(flowItems().map((element) => turnOf(element)).filter((turn) => turn !== null))].sort((a, b) => a - b),
    snapshot,
    parkInBand,
    parkAtBandTop,
    parkOffBand,
    revealTurn,
    notices: getNotices,
    chooseTarget,
    nudgeFocus,
    seenPosts,
    requests: () => sniffed.map((entry) => ({ method: entry.method, url: entry.url, body: entry.body, status: entry.status, accepted: entry.accepted, at: entry.at })),
    resetRequests: () => { sniffed = [] },
    dwellFallbackMs: DWELL_FALLBACK_MS,
    sleep,
    stop: () => { window.fetch = originalFetch },
  }

  log(`gate-c page ready (${GATE_C_VERSION}) visibility=${document.visibilityState} hasFocus=${document.hasFocus()}`
    + ` flow=${flow !== null} scroll=${scroll !== null && scroll !== undefined}`)
})()
