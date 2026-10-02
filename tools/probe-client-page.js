/**
 * Browser-side probe for the running `dsh-pet-seen` client half.
 *
 * HOW TO USE
 *   1. Open the DSH page, press F12, switch to the Console tab.
 *   2. Paste this whole file and press Enter.
 *   3. Read the printed report, then CLICK ON THE PAGE (the chat area) and wait
 *      about 4 seconds — the shadow dwell and the fetch sniffer only run while
 *      the page itself has focus.
 *   4. Click back into the Console and read what got logged in the meantime.
 *
 * WHAT IT ANSWERS
 *   - Is the client half loaded in this tab at all? (`tab-id` in sessionStorage)
 *   - Do the private selectors still exist, and which turn rows are rendered?
 *     (`[data-chat-flow]`, `[data-conversation-scroll]`, `[data-chat-turn]`)
 *   - How many flow items does one turn have, and of which kinds? This is the
 *     measurement D1 was found with: the first `[data-chat-turn]` match is a
 *     small header-sized row, while the answer is a later `assistant-step` item.
 *   - Would `isTurnVisible()` (the rule shipping in
 *     `src/client/visibility.ts`) say the finished turn's *result* is on
 *     screen? Both the old and the new reading are printed so a regression is
 *     visible at a glance.
 *   - Can the page reach the host's three same-origin routes?
 *   - Is the client runtime still alive right now? (patched `fetch` logs every
 *     `/pet-bridge/*` request the client makes)
 *   - Would the client's own L1->L3 ladder have fired, and after how long?
 *     (`SHADOW: ...`)
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It never posts `/seen`, never acks anything, and never marks a notice seen.
 *   It is a read-only observer; it cannot change the state it measures.
 *
 * @module tools/probe-client-page
 */

(async () => {
  const TAG = '[pet-probe]'
  const log = (...parts) => console.log(TAG, ...parts)

  /* Same selectors as src/client/visibility.ts — see FLOW_SELECTOR etc. */
  const FLOW_SELECTOR = '[data-chat-flow]'
  const SCROLL_SELECTOR = '[data-conversation-scroll]'
  const ACTIVE_SELECTOR = "[data-phase='active']"
  const TURN_ATTRIBUTE = 'data-chat-turn'
  const KIND_ATTRIBUTE = 'data-chat-flow-kind'
  /** Result-bearing kinds, most authoritative first — keep in sync with the module. */
  const RESULT_KINDS = ['assistant-step', 'turn-error', 'turn-max-tokens']

  /* Session the GUI is currently showing. Edit when probing another session. */
  const SESSION_ID = 'session-8290cdd7-8b12-4d70-8c40-51a8e124e58c'

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

  /** Every flow item the page renders, in document order. */
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
    const viewportTop = window.scrollY
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
   * The check `isTurnVisible()` performs, reported field by field.
   *
   * `legacy` reproduces the rule that shipped before the D1 fix — the first
   * `[data-chat-turn="N"]` match — so the two readings can be compared live.
   */
  const measure = (turn) => {
    const selector = `[data-chat-turn="${turn}"]`
    const items = flowItems().filter(element => turnOf(element) === turn)
    const legacyRow = flow?.querySelector(selector)
      ?? document.querySelector(`${ACTIVE_SELECTOR} ${selector}`)

    let group = null
    let groupKind = null
    for (const kind of RESULT_KINDS) {
      const box = unionBox(items.filter(element => element.getAttribute(KIND_ATTRIBUTE) === kind))
      if (box !== null) { group = box; groupKind = kind; break }
    }
    if (group === null) {
      group = unionBox(items)
      groupKind = group === null ? null : '(any item)'
    }

    const visibleBand = band()
    const overlapOf = (box) => box === null
      ? null
      : Math.round(Math.min(box.bottom, visibleBand.bottom) - Math.max(box.top, visibleBand.top))
    const legacyRect = legacyRow === null || legacyRow === undefined ? null : legacyRow.getBoundingClientRect()
    const legacyBox = legacyRect === null || legacyRect.width <= 0 || legacyRect.height <= 0
      ? null
      : { top: legacyRect.top, bottom: legacyRect.bottom }

    return {
      found: items.length > 0,
      items: items.length,
      kinds: items.map(element => element.getAttribute(KIND_ATTRIBUTE)),
      group: groupKind,
      resultBox: group === null ? '-' : `${Math.round(group.top)}..${Math.round(group.bottom)}`,
      resultOverlap: overlapOf(group),
      observed: group !== null && overlapOf(group) > 0,
      legacyRow: legacyRect === null ? '-' : `h=${Math.round(legacyRect.height)}`,
      legacyOverlap: overlapOf(legacyBox),
      legacyObserved: legacyBox !== null && overlapOf(legacyBox) > 0,
    }
  }

  log('================ environment ================')
  log('url         ', location.href)
  log('visibility  ', document.visibilityState, '| hasFocus', document.hasFocus())
  log('tab-id      ', sessionStorage.getItem('dsh-pet-seen:tab-id')
    ?? '(absent -> the client half never ran in this tab)')
  log('activeRoots ', document.querySelectorAll(ACTIVE_SELECTOR).length,
    '| flow', flow !== null, '| scroll', scroll !== null)

  const rows = flowItems()
  const turns = [...new Set(rows.map(row => turnOf(row)).filter(turn => turn !== null))]
  log('turn rows rendered:', turns.length === 0 ? '(none)' : turns.join(', '))

  log('================ geometry (viewport %d px) ================', window.innerHeight)
  if (turns.length === 0) log('no turn rows at all -> L3 can never hold')
  for (const turn of turns) log(`turn ${turn}:`, measure(turn))

  log('================ host routes seen from the page ================')
  let pending = []
  try {
    const response = await fetch(`/pet-bridge/notices?sessionId=${encodeURIComponent(SESSION_ID)}`)
    const payload = await response.json()
    pending = Array.isArray(payload.notices) ? payload.notices : []
    log('GET /pet-bridge/notices ->', response.status, JSON.stringify(payload))
  } catch (error) {
    log('GET /pet-bridge/notices FAILED:', String(error))
  }

  log('================ client liveness sniffer ================')
  const originalFetch = window.fetch
  let hits = 0
  window.fetch = function (...args) {
    const url = String(args[0]?.url ?? args[0])
    if (url.includes('pet-bridge')) {
      hits += 1
      log(`CLIENT FETCH #${hits}`, new Date().toLocaleTimeString(), url)
    }
    return originalFetch.apply(this, args)
  }
  log('armed: every /pet-bridge request the client makes from now on is logged above')

  log('================ shadow dwell (same ladder as the client) ================')
  const target = pending.find(notice => Number.isSafeInteger(Number(notice.targetTurnRef)))
  if (target === undefined) {
    log('nothing to watch: the host advertises no pending notice with a numeric targetTurnRef')
    window.__petProbe = {
      hits: () => hits,
      stop: () => { window.fetch = originalFetch; delete window.__petProbe; log('stopped') },
    }
    return
  }
  const turn = String(target.targetTurnRef)
  log(`watching notice ${target.noticeId} (turn ${turn})`)
  let since = null
  let reported = false
  const timer = setInterval(() => {
    const focused = document.visibilityState === 'visible' && document.hasFocus()
    const state = measure(turn)
    if (!focused || state.observed !== true) {
      if (since !== null) log('dwell broken:', focused ? 'row left the viewport' : 'page lost L1/L2')
      since = null
      return
    }
    if (since === null) {
      since = Date.now()
      log('dwell starts for turn', turn)
      return
    }
    const held = Date.now() - since
    if (held >= 1500 && !reported) {
      reported = true
      log(`SHADOW: the client SHOULD have reported /seen for ${target.noticeId} (dwell ${held} ms).`,
        'If the host still shows it as pending, the ladder is fine and the report is being lost or refused.')
    }
  }, 300)

  window.__petProbe = {
    hits: () => hits,
    stop: () => {
      clearInterval(timer)
      window.fetch = originalFetch
      delete window.__petProbe
      log('stopped')
    },
  }
  log('running — click on the page for ~4 s, then read this console again')
})()
