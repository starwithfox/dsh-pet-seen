/**
 * Browser-side visibility judgement for one page instance.
 *
 * The three levels, and why the third one exists:
 *
 * | Level | Signals | What it actually proves |
 * |---|---|---|
 * | L1 | `document.visibilityState === 'visible'` | the tab is not hidden |
 * | L2 | L1 **and** `document.hasFocus()` | the window is focused |
 * | L3 | L2 **and** the finished turn's own row is on screen, continuously, for `seenDwellMs` | the user had a real opportunity to see *this* result |
 *
 * The reference implementations in this ecosystem stop at L2, which is exactly
 * the bug this plugin exists to fix: with several sessions running, the user is
 * staring at session A while session B finishes. L2 is true — the tab is
 * visible and focused — and session B's completion is silently swallowed. The
 * user never learns B finished.
 *
 * So L2 is only ever *telemetry* here. Nothing below marks a notice seen; that
 * decision belongs to the host, which cross-checks the notice/run/session
 * triple against a live focus lease (see `POST /pet-bridge/seen`).
 *
 * @module dsh-pet-bridge/client/visibility
 */

/** Outcome of one visibility evaluation. */
export type VisibilityLevel = 'hidden' | 'visible' | 'focused' | 'observed'

/** DOM-facing knobs the mapper reads, kept injectable for tests. */
export interface DomFace {
  /** The element the conversation flow lives in, or null. */
  flowElement: () => Element | null
  /** The element the flow scrolls inside, or null when it is not virtualized. */
  scrollElement: () => Element | null
}

/**
 * Default DOM selectors.
 *
 * `data-chat-flow` is emitted on the conversation flow container in every
 * loading and content state, and `data-chat-turn` is the turn number carried by
 * each rendered row — the harness's own scroll anchoring and jump-to-turn code
 * resolves rows through it, which is what makes it a contract rather than a
 * guess. It is still an internal attribute, so {@link createDomFace} treats a
 * missing row as "not observed" instead of throwing.
 */
export const FLOW_SELECTOR = '[data-chat-flow]'
/** Scroll container; falls back to the flow element when absent. */
export const SCROLL_SELECTOR = '[data-conversation-scroll]'
/** Active conversation root, used to ignore hidden/stale panes. */
export const ACTIVE_SELECTOR = "[data-phase='active']"

/**
 * Build the DOM face from the real document.
 *
 * @param root - document to read; defaults to the page's own.
 * @returns a {@link DomFace} bound to that root.
 */
export function createDomFace(root?: Document): DomFace {
  const doc = root ?? (typeof document === 'undefined' ? undefined : document)
  const query = (selector: string): Element | null => {
    if (doc === undefined) return null
    const active = doc.querySelector(ACTIVE_SELECTOR)
    const scope: ParentNode = active ?? doc
    return scope.querySelector(selector) ?? doc.querySelector(selector)
  }
  return {
    flowElement: () => query(FLOW_SELECTOR),
    scrollElement: () => query(SCROLL_SELECTOR) ?? query(FLOW_SELECTOR),
  }
}

/**
 * L1 + L2 only. Deliberately says nothing about whether the user is looking at
 * the *right* conversation.
 *
 * @param doc - document to inspect.
 * @returns `'hidden'`, `'visible'`, or `'focused'`.
 */
export function basicLevel(doc: Document): VisibilityLevel {
  if (doc.visibilityState !== 'visible') return 'hidden'
  return doc.hasFocus() ? 'focused' : 'visible'
}

/**
 * Whether a row for `turn` is inside the visible intersection of the flow's
 * scroll container and the viewport.
 *
 * The row is searched for from the flow element, then from the document: the
 * harness virtualizes old history, so a turn that has scrolled out of the
 * rendered window has no row at all, and that must read as "not observed"
 * rather than as an error.
 *
 * Occlusion is not modelled: an element covered by another one still counts.
 * That is a deliberate limit — `elementFromPoint` makes the check flaky around
 * sticky headers and the composer overlay, and a stricter check that misfires
 * would resurrect exactly the "silently swallowed notice" problem this module
 * exists to prevent.
 *
 * @param dom - DOM face to inspect.
 * @param turn - the turn number to look for.
 * @param viewportHeight - current viewport height.
 * @returns whether the row exists and intersects the visible area.
 */
export function isTurnRowVisible(
  dom: DomFace,
  turn: number,
  viewportHeight: number,
): boolean {
  const flow = dom.flowElement()
  if (flow === null) return false
  const selector = `[data-chat-turn="${turn}"]`
  const row = flow.querySelector(selector)
    ?? flow.ownerDocument.querySelector(`${ACTIVE_SELECTOR} ${selector}`)
  if (row === null) return false
  const rect = row.getBoundingClientRect()
  // Zero-size means not rendered (a virtualized placeholder, or a collapsed row).
  if (rect.width <= 0 || rect.height <= 0) return false
  const scroll = dom.scrollElement()
  const bounds = scroll === null ? { top: 0, bottom: viewportHeight } : scroll.getBoundingClientRect()
  const top = Math.max(rect.top, bounds.top)
  const bottom = Math.min(rect.bottom, bounds.bottom)
  return bottom - top > 0
}

/**
 * Edge-triggered visibility tracker.
 *
 * Update it from browser events (`focus`, `blur`, `visibilitychange`, scroll,
 * `pagehide`) and from DOM mutations; it runs the L1→L3 ladder itself and calls
 * {@link VisibilityTracker.update} at most once per target transition.
 *
 * A target whose dwell is interrupted — tab hidden, window blurred, rows
 * re-rendered, or the awaited turn changing — restarts from zero. Nothing is
 * carried over from a previous observation, which is what stops a stale "the
 * user was looking earlier" from retiring a brand-new notice.
 */export class VisibilityTracker {
  private target: { sessionId: string, noticeId: string, turn: number } | null = null
  /** Epoch ms the current target first satisfied every L3 condition. */
  private dwellStartedAt: number | null = null
  private reported = false
  private readonly dwellMs: number
  private readonly now: () => number
  private readonly dom: DomFace
  private readonly viewportHeight: () => number

  constructor(options: {
    dom: DomFace
    dwellMs: number
    /** Epoch-ms clock; injectable for tests. */
    now?: () => number
    /** Viewport height source; injectable for tests. */
    viewportHeight?: () => number
  }) {
    this.dom = options.dom
    this.dwellMs = options.dwellMs
    this.now = options.now ?? (() => Date.now())
    this.viewportHeight = options.viewportHeight
      ?? (() => (typeof window === 'undefined' ? 0 : window.innerHeight))
  }

  /**
   * Declare which result should be watched.
   *
   * @param target - the notice's identifiers plus its turn number, or null to
   *   clear the watch (session switch, run change, tab losing focus).
   */
  setTarget(target: { sessionId: string, noticeId: string, turn: number } | null): void {
    if (target === null) {
      this.target = null
      this.dwellStartedAt = null
      this.reported = false
      return
    }
    const same = this.target !== null
      && this.target.sessionId === target.sessionId
      && this.target.noticeId === target.noticeId
      && this.target.turn === target.turn
    if (same) return
    this.target = target
    this.dwellStartedAt = null
    this.reported = false
  }

  /** The target currently being watched, if any. */
  currentTarget(): { sessionId: string, noticeId: string, turn: number } | null {
    return this.target === null ? null : { ...this.target }
  }

  /**
   * Evaluate the ladder and report once per target.
   *
   * @param doc - the page document.
   * @returns the level reached, the reported notice id when a report just
   *   fired, and dwell bookkeeping for diagnostics.
   */
  update(doc: Document): {
    level: VisibilityLevel
    report: { noticeId: string, sessionId: string } | null
    dwellMs: number
  } {
    const base = basicLevel(doc)
    const now = this.now()
    if (base !== 'focused') {
      // Any loss of L1/L2 breaks continuous dwell: restart the clock.
      this.dwellStartedAt = null
      this.reported = false
      return { level: base, report: null, dwellMs: 0 }
    }
    const target = this.target
    if (target === null) return { level: 'focused', report: null, dwellMs: 0 }
    if (!isTurnRowVisible(this.dom, target.turn, this.viewportHeight())) {
      this.dwellStartedAt = null
      this.reported = false
      return { level: 'focused', report: null, dwellMs: 0 }
    }
    if (this.dwellStartedAt === null) this.dwellStartedAt = now
    const dwellMs = now - this.dwellStartedAt
    if (dwellMs < this.dwellMs) return { level: 'focused', report: null, dwellMs }
    if (this.reported) return { level: 'observed', report: null, dwellMs }
    this.reported = true
    return {
      level: 'observed',
      report: { noticeId: target.noticeId, sessionId: target.sessionId },
      dwellMs,
    }
  }
}
