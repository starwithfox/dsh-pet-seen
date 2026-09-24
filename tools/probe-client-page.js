/**
 * Browser-side probe for the running `dsh-pet-bridge` client half.
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
 *   - Do the three private selectors still exist, and which turn rows are
 *     rendered? (`[data-chat-flow]`, `[data-conversation-scroll]`,
 *     `[data-chat-turn="N"]`)
 *   - Would `isTurnRowVisible()` (copied verbatim from
 *     `src/client/visibility.ts`) say the finished turn is on screen?
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

  /* Same three selectors as src/client/visibility.ts — see FLOW_SELECTOR etc. */
  const FLOW_SELECTOR = '[data-chat-flow]'
  const SCROLL_SELECTOR = '[data-conversation-scroll]'
  const ACTIVE_SELECTOR = "[data-phase='active']"

  /* Session the GUI is currently showing. Edit when probing another session. */
  const SESSION_ID = 'session-8290cdd7-8b12-4d70-8c40-51a8e124e58c'

  const query = (selector) => {
    const active = document.querySelector(ACTIVE_SELECTOR)
    return (active ?? document).querySelector(selector) ?? document.querySelector(selector)
  }
  const flow = query(FLOW_SELECTOR)
  const scroll = query(SCROLL_SELECTOR) ?? flow

  log('================ environment ================')
  log('url         ', location.href)
  log('visibility  ', document.visibilityState, '| hasFocus', document.hasFocus())
  log('tab-id      ', sessionStorage.getItem('dsh-pet-bridge:tab-id')
    ?? '(absent -> the client half never ran in this tab)')
  log('activeRoots ', document.querySelectorAll(ACTIVE_SELECTOR).length,
    '| flow', flow !== null, '| scroll', scroll !== null)

  const rows = [...document.querySelectorAll('[data-chat-turn]')]
  const turns = [...new Set(rows.map(row => row.dataset.chatTurn))]
  log('turn rows rendered:', turns.length === 0 ? '(none)' : turns.join(', '))

  /** The check `isTurnRowVisible()` performs, reported field by field. */
  const measure = (turn) => {
    const selector = `[data-chat-turn="${turn}"]`
    const row = flow?.querySelector(selector)
      ?? document.querySelector(`${ACTIVE_SELECTOR} ${selector}`)
    if (row === null || row === undefined) return { found: false }
    const rect = row.getBoundingClientRect()
    const bounds = scroll === null || scroll === undefined
      ? { top: 0, bottom: window.innerHeight }
      : scroll.getBoundingClientRect()
    const overlap = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)
    return {
      found: true,
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      row: `${Math.round(rect.top)}..${Math.round(rect.bottom)}`,
      scroll: `${Math.round(bounds.top)}..${Math.round(bounds.bottom)}`,
      overlap: Math.round(overlap),
      observed: rect.width > 0 && rect.height > 0 && overlap > 0,
    }
  }

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
