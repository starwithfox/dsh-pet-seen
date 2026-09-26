/**
 * Browser-side visibility judgement for one page instance.
 *
 * The three levels, and why the third one exists:
 *
 * | Level | Signals | What it actually proves |
 * |---|---|---|
 * | L1 | `document.visibilityState === 'visible'` | the tab is not hidden |
 * | L2 | L1 **and** `document.hasFocus()` | the window is focused |
 * | L3 | L2 **and** the finished turn is on screen, continuously, for `seenDwellMs` | the user had a real opportunity to see *this* result |
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
 * ## Why a turn is measured as a union of rows
 *
 * `[data-chat-turn="N"]` is **not** unique per turn: the harness stamps it on
 * every conversation-flow item belonging to that turn, and `querySelector`
 * therefore returns an arbitrary small one — a turn header, a tool row, or a
 * collapsed placeholder — rather than the reply the user is reading. Measuring
 * only that first match was a real, device-verified defect: the reply is
 * thousands of pixels tall, so scrolling far enough to read it always pushed
 * the small first match off screen, and L3 never held.
 *
 * A turn is instead considered on screen when the **union of its rendered
 * (non-zero-height) items** intersects the visible band. That is the honest
 * reading of "this result is on screen": it does not depend on which item the
 * DOM happens to list first, it ignores the zero-height virtualisation
 * placeholders, and it degrades to "the one item that exists" when a turn
 * renders a single row.
 *
 * @module dsh-pet-bridge/client/visibility
 */

/** Outcome of one visibility evaluation. */
export type VisibilityLevel = 'hidden' | 'visible' | 'focused' | 'observed'

/** An axis-aligned rectangle in viewport coordinates. */
export interface RectFace {
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

/** The slice of `Element` this module measures. */
export interface ElementFace {
  getBoundingClientRect: () => RectFace
}

/** A query scope: `Document` or `Element` both satisfy this. */
export interface QueryScope {
  querySelectorAll: (selectors: string) => ArrayLike<ElementLike>
}

/** The slice of `Element` a query scope needs to read. */
export interface ElementLike extends ElementFace {
  getAttribute: (name: string) => string | null
}

/** DOM-facing dependencies, kept injectable so tests need no real DOM. */
export interface VisibilityDeps {
  /** Document to search when the flow element is missing, or null. */
  readonly document: QueryScope | null
  /** The element the conversation flow lives in, or null. */
  readonly flowElement: (ElementFace & QueryScope) | null
  /** The element the flow scrolls inside, or null when it is not virtualized. */
  readonly scrollElement: (ElementFace & QueryScope) | null
  /** Current viewport height in px. */
  readonly viewportHeight: () => number
  /** Measure one element. Injectable so a test double need not be an Element. */
  readonly rectOf: (element: ElementFace) => RectFace
}

/**
 * Default DOM selectors.
 *
 * `data-chat-flow` is emitted on the conversation flow container in every
 * loading and content state, and `data-chat-turn` is the turn number carried by
 * every rendered flow item — the harness's own scroll anchoring and
 * jump-to-turn code resolves rows through it, which is what makes it a
 * contract rather than a guess. It is still an internal attribute, so
 * {@link isTurnVisible} treats a missing row as "not observed" instead of
 * throwing.
 */
export const FLOW_SELECTOR = '[data-chat-flow]'
/** Scroll container; falls back to the flow element when absent. */
export const SCROLL_SELECTOR = '[data-conversation-scroll]'
/** Active conversation root, used to ignore hidden/stale panes. */
export const ACTIVE_SELECTOR = "[data-phase='active']"
/** Attribute carrying the turn number of a conversation-flow item. */
export const TURN_ATTRIBUTE = 'data-chat-turn'
/** Attribute carrying the kind of a conversation-flow item. */
export const KIND_ATTRIBUTE = 'data-chat-flow-kind'

/**
 * Flow-item kinds that hold a turn's primary result, most authoritative first.
 *
 * `assistant-step` is the answer the user came to read — with the turn-process
 * disclosure open, a long turn renders one item per step, and they are measured
 * together. The two failure kinds are the result of a turn that produced no
 * answer, and are the only thing left to see. Every other kind belongs to the
 * turn's process disclosure (`reasoning`, `tool-call`, …) or to the prompt
 * (`user`, `steering`, `context`, `system-prompt`), which are not what
 * completion is about.
 */
export const RESULT_KINDS: readonly string[] = ['assistant-step', 'turn-error', 'turn-max-tokens']

/** Selector matching every flow item, used when no result kind rendered. */
const ANY_TURN_ITEM = `[${TURN_ATTRIBUTE}]`

/**
 * One attribute on one element, or null.
 *
 * Kept local and defensive because every selector below is an upstream internal
 * contract: a harness that stops emitting one of these must degrade to "not
 * observed", never break the page.
 *
 * @param element - candidate element.
 * @param name - attribute name.
 * @returns the attribute value, or null when absent or unreadable.
 */
function attributeOf(element: unknown, name: string): string | null {
  if (element === null || typeof element !== 'object') return null
  const reader = (element as { getAttribute?: unknown }).getAttribute
  if (typeof reader !== 'function') return null
  try {
    const value = (reader as (this: unknown, attribute: string) => unknown).call(element, name)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** Narrow an unknown node to something this module can measure. */
function asElementLike(node: unknown): ElementLike | null {
  if (node === null || typeof node !== 'object') return null
  const candidate = node as { getBoundingClientRect?: unknown, getAttribute?: unknown }
  if (typeof candidate.getBoundingClientRect !== 'function') return null
  if (typeof candidate.getAttribute !== 'function') return null
  return node as ElementLike
}

/**
 * Turn number of one flow item, or null when it carries no usable one.
 *
 * @param element - a matched flow item.
 * @returns the turn number, or null.
 */
export function turnNumberOf(element: ElementLike | unknown): number | null {
  const raw = attributeOf(element, TURN_ATTRIBUTE)
  if (raw === null || raw === '') return null
  const turn = Number(raw)
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/** Flow-item kind of one item, or null. */
export function kindOf(element: ElementLike | unknown): string | null {
  const raw = attributeOf(element, KIND_ATTRIBUTE)
  return raw === null || raw === '' ? null : raw
}

/**
 * Every conversation-flow item the page can see, in document order.
 *
 * One query for the whole conversation rather than one per turn: the caller
 * asks about single turns, and re-querying per turn would re-scan the flow and
 * re-encode the turn number into a selector string.
 *
 * The flow element is tried first, then the document: the harness virtualizes
 * old history, so a turn that has scrolled out of the rendered window has no
 * item at all, and the caller must read that as "not observed" rather than as
 * an error.
 *
 * @param deps - DOM face to inspect.
 * @returns the matched items.
 */
export function flowItems(deps: VisibilityDeps): ElementLike[] {
  for (const scope of [deps.flowElement, deps.document]) {
    if (scope === null) continue
    let matched: ArrayLike<unknown>
    try {
      matched = scope.querySelectorAll(ANY_TURN_ITEM) as ArrayLike<unknown>
    } catch {
      // A future harness could make this throw; "not observed" is the safe read.
      continue
    }
    const items: ElementLike[] = []
    for (let index = 0; index < matched.length; index += 1) {
      const item = asElementLike(matched[index])
      if (item !== null) items.push(item)
    }
    if (items.length > 0) return items
  }
  return []
}

/**
 * All items of one turn, in document order.
 *
 * @param deps - DOM face to inspect.
 * @param turn - the turn number to collect.
 * @returns the turn's items; empty when the turn is not rendered.
 */
export function turnItems(deps: VisibilityDeps, turn: number): ElementLike[] {
  return flowItems(deps).filter(item => turnNumberOf(item) === turn)
}

/**
 * Build the DOM face from the real document.
 *
 * @param root - document to read; defaults to the page's own.
 * @returns a {@link VisibilityDeps} bound to that root.
 */
export function createVisibilityDeps(root?: Document): VisibilityDeps {
  const doc = root ?? (typeof document === 'undefined' ? undefined : document)
  const asScope = (value: Element | null): (ElementFace & QueryScope) | null =>
    value as unknown as (ElementFace & QueryScope) | null
  const query = (selector: string): Element | null => {
    if (doc === undefined) return null
    const active = doc.querySelector(ACTIVE_SELECTOR)
    const activeScope: ParentNode = active ?? doc
    return activeScope.querySelector(selector) ?? doc.querySelector(selector)
  }
  return {
    document: (doc as unknown as QueryScope | undefined) ?? null,
    flowElement: asScope(doc === undefined ? null : query(FLOW_SELECTOR)),
    scrollElement: asScope(doc === undefined ? null : query(SCROLL_SELECTOR) ?? query(FLOW_SELECTOR)),
    viewportHeight: () => (typeof window === 'undefined' ? 0 : window.innerHeight),
    rectOf: element => element.getBoundingClientRect(),
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
 * The band a turn must intersect to count as on screen: the scroll container's
 * box clipped to the viewport, so an element scrolled under the composer or
 * above the window top is not credited.
 *
 * @param deps - DOM face to inspect.
 * @returns viewport-relative `top`/`bottom`.
 */
function visibleBand(deps: VisibilityDeps): { top: number, bottom: number } {
  const viewportHeight = deps.viewportHeight()
  const scroll = deps.scrollElement
  const bounds = scroll === null ? null : deps.rectOf(scroll)
  const viewportTop = typeof window === 'undefined' || typeof window.scrollY !== 'number' ? 0 : window.scrollY
  const viewportBottom = viewportTop + viewportHeight
  if (bounds === null) return { top: viewportTop, bottom: viewportBottom }
  return {
    top: Math.max(bounds.top, viewportTop),
    bottom: Math.min(bounds.bottom, viewportBottom),
  }
}

/**
 * Union box of the rendered items among `items`, or null when none is rendered.
 *
 * Zero-width and zero-height items are skipped: the harness keeps a zero-height
 * flow item per unloaded turn, and counting those would make an off-screen turn
 * look as if it spanned the whole conversation.
 *
 * @param deps - DOM face to inspect.
 * @param items - candidate items of one group.
 * @returns the union rectangle, or null.
 */
export function unionBox(deps: VisibilityDeps, items: readonly ElementLike[]): RectFace | null {
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  let width = 0
  for (const item of items) {
    const rect = deps.rectOf(item)
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.top < top) top = rect.top
    if (rect.bottom > bottom) bottom = rect.bottom
    if (rect.width > width) width = rect.width
  }
  if (bottom <= top) return null
  return { top, bottom, width, height: bottom - top }
}

/**
 * The box that stands for a turn's *result*, or null when no reliable result of
 * it is rendered.
 *
 * This is the whole of D1. Measuring "the turn" as `[data-chat-turn="N"]`'s
 * first match measured a header-sized row a few dozen pixels tall, while the
 * answer it belonged to was thousands of pixels tall; scrolling far enough to
 * read the answer therefore always pushed that row off screen, so L3 never
 * held and no popup was ever retracted. The result is instead the turn's
 * primary content:
 *
 * 1. the answer items (`assistant-step`) — every step when the process
 *    disclosure is open, measured together;
 * 2. failing that, the turn's failure item (`turn-error`, `turn-max-tokens`),
 *    which *is* the result of a turn that produced no answer;
 * 3. failing both, nothing. A turn whose every rendered row is prompt or
 *    process material (`user`, `steering`, `system-prompt`, `context`,
 *    `reasoning`, `tool-call`, `turn-process`, `turn-tail`, …) has no result on
 *    screen to read, and "the user had a real opportunity to see this result"
 *    is simply false about it.
 *
 * Taking the *union* of a result group, rather than its tallest single item,
 * means the answer counts as on screen while the user is anywhere inside it,
 * which is exactly the reading the dwell rule needs. A group with no rendered
 * member is not used at all, so a collapsed or zero-height answer does not
 * report an off-screen turn as seen.
 *
 * Rule 3 used to fall back to the union of *every* item of the turn. That was a
 * defect: with the answer not rendered — a virtualized or collapsed turn, or a
 * turn that only ever produced process rows — the user's own message or a tool
 * row stood in for the result, and the notice was retired while nobody had seen
 * anything. It is the same "silently swallowed notice" failure this module
 * exists to prevent, so the fallback is gone and the caller reads null as "not
 * observed".
 *
 * @param deps - DOM face to inspect.
 * @param turn - the turn number to measure.
 * @returns the result rectangle, or null when the turn shows no result.
 */
export function turnResultBox(deps: VisibilityDeps, turn: number): RectFace | null {
  const items = turnItems(deps, turn)
  if (items.length === 0) return null
  for (const kind of RESULT_KINDS) {
    const box = unionBox(deps, items.filter(item => kindOf(item) === kind))
    if (box !== null) return box
  }
  return null
}

/**
 * Whether the finished `turn`'s result occupies any part of the visible band.
 *
 * A turn whose header is on screen but whose answer is not is deliberately
 * *not* visible: the header is not what the user is being asked to read.
 *
 * Occlusion is not modelled: an element covered by another one still counts.
 * That is a deliberate limit — `elementFromPoint` makes the check flaky around
 * sticky headers and the composer overlay, and a stricter check that misfires
 * would resurrect exactly the "silently swallowed notice" problem this module
 * exists to prevent.
 *
 * @param deps - DOM face to inspect.
 * @param turn - the turn number to look for.
 * @returns whether the turn's result is inside the visible band.
 */
export function isTurnVisible(deps: VisibilityDeps, turn: number): boolean {
  const box = turnResultBox(deps, turn)
  if (box === null) return false
  const band = visibleBand(deps)
  const top = Math.max(box.top, band.top)
  const bottom = Math.min(box.bottom, band.bottom)
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
 */
export class VisibilityTracker {
  private target: { sessionId: string, noticeId: string, turn: number } | null = null
  /** Epoch ms the current target first satisfied every L3 condition. */
  private dwellStartedAt: number | null = null
  private reported = false
  private dwellMs: number
  private readonly now: () => number
  private deps: VisibilityDeps
  private readonly canReport: ((target: { sessionId: string, noticeId: string, turn: number }) => boolean) | undefined

  constructor(options: {
    deps: VisibilityDeps
    dwellMs: number
    /** Epoch-ms clock; injectable for tests. */
    now?: () => number
    /**
     * Extra gate consulted immediately before a report fires.
     *
     * The caller owns pacing — how often a target may be reported again after a
     * refusal — while this class owns dwell. A blocked report is not consumed:
     * the dwell state is left alone, so the next evaluation asks again.
     */
    canReport?: (target: { sessionId: string, noticeId: string, turn: number }) => boolean
  }) {
    this.deps = options.deps
    this.dwellMs = options.dwellMs
    this.now = options.now ?? (() => Date.now())
    this.canReport = options.canReport
  }

  /**
   * Swap the DOM face. Used when the page itself is replaced, and by tests.
   *
   * @param deps - the new DOM face.
   */
  setDeps(deps: VisibilityDeps): void {
    this.deps = deps
  }

  /** Continuous-visibility threshold currently in force, in ms. */
  currentDwellMs(): number {
    return this.dwellMs
  }

  /**
   * Whether a turn's result is on screen right now.
   *
   * Exposed so the page can pick a watch target it is actually able to confirm,
   * instead of queueing behind a notice that is scrolled out of view.
   *
   * @param turn - the turn number to check.
   * @returns whether the turn occupies part of the visible band.
   */
  isTurnOnScreen(turn: number): boolean {
    return isTurnVisible(this.deps, turn)
  }

  /**
   * Adopt a new dwell threshold, restarting the clock.
   *
   * A threshold change is a policy change, so the time already accumulated
   * under the old one must not count towards the new one: shortening the
   * threshold may then report sooner, but lengthening it can never be
   * defeated by time banked under the old value.
   *
   * @param dwellMs - the new threshold; non-finite or negative values are ignored.
   * @returns whether the threshold actually changed.
   */
  setDwellMs(dwellMs: number): boolean {
    if (!Number.isFinite(dwellMs) || dwellMs < 0) return false
    if (dwellMs === this.dwellMs) return false
    this.dwellMs = dwellMs
    this.dwellStartedAt = null
    this.reported = false
    return true
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
   * Re-arm the current target so L3 can fire again.
   *
   * Used when a report was refused for a reason that may not repeat — a focus
   * lease the host had not yet refreshed, say. Without this the target counts
   * as reported forever and a single refusal would blacklist the notice for the
   * life of the page, which is the defect this round fixes. The dwell clock
   * restarts, so a second report still requires the user to have kept looking.
   *
   * @returns whether there is a target to re-arm.
   */
  rearm(): boolean {
    if (this.target === null) return false
    this.dwellStartedAt = null
    this.reported = false
    return true
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
    if (!isTurnVisible(this.deps, target.turn)) {
      this.dwellStartedAt = null
      this.reported = false
      return { level: 'focused', report: null, dwellMs: 0 }
    }
    if (this.dwellStartedAt === null) this.dwellStartedAt = now
    const dwellMs = now - this.dwellStartedAt
    if (dwellMs < this.dwellMs) return { level: 'focused', report: null, dwellMs }
    if (this.reported) return { level: 'observed', report: null, dwellMs }
    // A caller that is pacing reports answers "not yet" here; the dwell state
    // is deliberately left intact so the next evaluation can report.
    if (this.canReport !== undefined && !this.canReport(target)) {
      return { level: 'observed', report: null, dwellMs }
    }
    this.reported = true
    return {
      level: 'observed',
      report: { noticeId: target.noticeId, sessionId: target.sessionId },
      dwellMs,
    }
  }
}
