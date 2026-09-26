/**
 * Page-side session selection for the CDP acceptance driver.
 *
 * WHY THIS FILE EXISTS
 *   A notice is minted for the session that settled a run, and the harness has no
 *   session deep link. A fresh Chrome profile therefore lands on the
 *   *new-conversation placeholder*, not on the most recent session, so no
 *   `[data-chat-flow]` is ever rendered and the acceptance run has no target
 *   (measured in ROUND 4: `flow=false turns=0` while the session list showed the
 *   target session one row down).
 *
 *   The sidebar is consequently the only way in, and the session id is **not in
 *   the DOM**: `dsh-client-ui-workspace` renders every row as
 *   `div[role="treeitem"]` and keeps the id in React props
 *   (`onClick: () => onOpen(node.id)`). ROUND 4's `describeSessions()` searched
 *   for `[data-session-id]` / `[data-session-key]` / `[role="option"]`; none of
 *   those exist anywhere in the installed packages, so it silently matched
 *   nothing. This file replaces that guess with the two sources of truth that do
 *   exist, in order:
 *
 *     1. `fiber-id`   — the row's own React props (`props.node.id`), exact.
 *     2. `title-text` — the row whose visible text is the title the host itself
 *                       reported for that session in `/state` (exact text first,
 *                       then a containing row, since the sidebar decorates the
 *                       title with more than the title).
 *
 *   Nothing is clicked unless one of those matched, and the strategy used is
 *   reported, so a fallback can never be mistaken for the primary path.
 *
 *   The title fallback deliberately tries the whole `textContent` first. A
 *   substring test alone lets a *longer* title that merely contains the wanted
 *   one win whenever it happens to be listed earlier, and opening the wrong
 *   session is worse than opening none: the acceptance run would then look like
 *   it reached a conversation while looking at a different one.
 *
 * CONTRACT
 *   Reads `window.__petSessionPickRequest`:
 *     `{ sessionId?: string|null, title?: string|null, open?: boolean }`
 *   Publishes the JSON result on `window.__petSessionPickResult` and resolves to
 *   the same string, so the driver can feed this file to the page **verbatim**
 *   (the same property `acceptance-client-page.js` relies on: the tested bytes
 *   and the executed bytes are one file).
 *
 *   Result shape:
 *     `{ wanted, matchedBy, clicked, fibersExposed, rows: [{ index, id, title,
 *        text, selected }] }`
 */
(async () => {
  const request = window.__petSessionPickRequest ?? {}
  const wanted = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : null
  const wantedTitle = typeof request.title === 'string' && request.title !== '' ? request.title : null
  const shouldOpen = request.open === true

  /** React attaches internal keys with a random suffix; only the prefix is stable. */
  const keyFor = (element, prefix) => {
    try {
      return Object.keys(element).find(key => key.startsWith(prefix)) ?? null
    } catch {
      return null
    }
  }

  /**
   * Recover one row's identity from its React fiber.
   *
   * The DOM node's own props only hold `onClick`; the id lives on an ancestor
   * component's props (`SessionNodeItem({ node })`), so the `return` chain is
   * walked until a node-shaped prop appears. The depth cap keeps a future
   * refactor from turning this into an unbounded walk.
   */
  const describeRow = (element) => {
    const fiberKey = keyFor(element, '__reactFiber$')
    let fiber = fiberKey === null ? null : element[fiberKey]
    let id = null
    let title = null
    for (let depth = 0; fiber !== null && fiber !== undefined && depth < 15; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (props === null || props === undefined) continue
      const node = props.node ?? props.session ?? props.item ?? props.result
      if (node !== null && node !== undefined && typeof node.id === 'string' && node.id !== '') {
        id = node.id
        title = typeof node.title === 'string' && node.title !== '' ? node.title : null
        break
      }
    }
    return {
      id,
      title,
      text: (element.textContent ?? '').trim().slice(0, 80),
      selected: element.getAttribute('aria-selected') === 'true',
    }
  }

  const elements = [...document.querySelectorAll('[role="treeitem"]')]
  const rows = elements.map((element, index) => ({ index, ...describeRow(element) }))

  let matchedBy = null
  let target = null
  if (wanted !== null) {
    const byId = elements.find(element => describeRow(element).id === wanted)
    if (byId !== undefined) {
      target = byId
      matchedBy = 'fiber-id'
    }
  }
  if (target === null && wantedTitle !== null) {
    const textOf = element => (element.textContent ?? '').trim()
    /*
     * Exact whole-row text first: when the row renders nothing but the title,
     * this picks it out unambiguously even if a longer title containing it sits
     * above it. The substring pass stays as the broad fallback for the rows the
     * sidebar decorates.
     */
    const exact = elements.find(element => textOf(element) === wantedTitle)
    const byTitle = exact ?? elements.find(element => textOf(element).includes(wantedTitle))
    if (byTitle !== undefined) {
      target = byTitle
      matchedBy = 'title-text'
    }
  }

  /*
   * Open it the way a click does. The row's `onClick` already closes over the
   * right id, so invoking it avoids re-deriving which session to open.
   */
  let clicked = false
  if (shouldOpen && target !== null) {
    const propsKey = keyFor(target, '__reactProps$')
    const props = propsKey === null ? null : target[propsKey]
    if (props !== null && props !== undefined && typeof props.onClick === 'function') {
      props.onClick()
      clicked = true
    } else {
      target.click()
      clicked = true
    }
  }

  const result = {
    wanted,
    wantedTitle,
    matchedBy,
    clicked,
    fibersExposed: keyFor(document.body, '__reactFiber$') !== null,
    rows,
  }
  window.__petSessionPickResult = JSON.stringify(result)
  return window.__petSessionPickResult
})()
