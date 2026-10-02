/**
 * A DOM double for the browser half's tests.
 *
 * The visibility logic needs two things from a page: `querySelectorAll` for the
 * three selectors it uses, and geometry for the elements it finds. No DOM
 * library can supply the second one — without a layout engine every
 * `getBoundingClientRect()` is zeros — so the suite uses a double that exposes
 * only what the shipping code touches, and lets each test assign the geometry
 * the case is about.
 *
 * Only the attributes and selectors the plugin declares are understood; a
 * selector the client does not use is a test bug and throws rather than
 * silently matching nothing.
 *
 * @module tests/client-fixture
 */

import type { RectFace, VisibilityDeps } from '../src/client/visibility.js'
import type { PendingNotice } from '../src/protocol.js'

/** Viewport height used unless a test overrides it. */
export const DEFAULT_VIEWPORT_HEIGHT = 1200

/** The selector subsets the browser half actually issues. */
type SelectorMatcher = (element: FixtureElement) => boolean

/** One fake conversation-flow item. */
export class FixtureElement {
  readonly rect: RectFace
  private readonly attributes: Record<string, string>
  private items: FixtureElement[]

  constructor(attributes: Record<string, string>, rect: Partial<RectFace> = {}) {
    this.attributes = { ...attributes }
    this.rect = {
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 800,
      height: rect.height ?? Math.max(0, (rect.bottom ?? 0) - (rect.top ?? 0)),
    }
    this.items = []
  }

  /** Replace this element's geometry. */
  setRect(rect: Partial<RectFace>): void {
    const top = rect.top ?? this.rect.top
    const bottom = rect.bottom ?? top + this.rect.height
    // An explicit height wins, which is how a zero-height virtualisation
    // placeholder is expressed.
    const height = rect.height ?? Math.max(0, bottom - top)
    Object.assign(this.rect, {
      top,
      bottom: rect.bottom ?? top + height,
      width: rect.width ?? this.rect.width,
      height,
    })
  }

  /** Replace the elements a `querySelectorAll` on this node would match. */
  setItems(items: FixtureElement[]): void {
    this.items = items
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getBoundingClientRect(): RectFace {
    return { ...this.rect }
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FixtureElement[] {
    const matches = this.items.filter(matchSelector(selector))
    return matches
  }
}

/** Match one of the selectors the plugin issues. */
function matchSelector(selector: string): SelectorMatcher {
  if (selector === '[data-chat-flow]') return element => element.getAttribute('data-chat-flow') !== null
  if (selector === '[data-conversation-scroll]') {
    return element => element.getAttribute('data-conversation-scroll') !== null
  }
  if (selector === "[data-phase='active']") return element => element.getAttribute('data-phase') === 'active'
  const attribute = /^\[([a-z-]+)\]$/.exec(selector)
  if (attribute?.[1] !== undefined) {
    const name = attribute[1]
    return element => element.getAttribute(name) !== null
  }
  throw new Error(`tests/client-fixture: unimplemented selector ${selector}`)
}

/** A fake document holding the conversation flow and its scroll container. */
export class FixtureDocument {
  /**
   * The conversation flow container.
   *
   * Not `readonly`: {@link FixtureDocument.remount} swaps in fresh nodes the way
   * the harness does on a session switch. That swap is the only way to tell a
   * face that follows the document from one frozen at construction time.
   */
  flow: FixtureElement
  /** The flow's scroll container. See {@link FixtureDocument.flow}. */
  scroll: FixtureElement
  /** Mutation-observation root; never confused with a flow item. */
  readonly documentElement: FixtureElement
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT
  visibleState: 'visible' | 'hidden' = 'visible'
  focused = true
  scrollY = 0
  /** Everything the client asks this document to observe. */
  readonly observed: string[] = []

  constructor() {
    this.flow = new FixtureElement({ 'data-chat-flow': '' })
    this.scroll = new FixtureElement({ 'data-conversation-scroll': '' }, { top: 76, bottom: 1_279 })
    this.documentElement = new FixtureElement({})
  }

  /**
   * Set the flow items the page renders.
   *
   * @param items - the items, in document order.
   */
  setItems(items: FixtureElement[]): void {
    this.flow.setItems(items)
  }

  /**
   * Replace the conversation subtree, as the harness does when the session
   * switches: the old flow/scroll nodes survive in the page's object graph but
   * are detached, and the fresh pair carries the rows.
   *
   * The detached pair is deliberately left holding **nothing** and measuring
   * **zero**, which is what makes the defect visible: a DOM face captured once
   * keeps reading the dead pair, so every rectangle it measures is 0 and no turn
   * can ever be on screen again.
   *
   * @param items - what the new flow renders, in document order.
   */
  remount(items: FixtureElement[] = []): void {
    this.flow.setItems([])
    this.flow.setRect({ top: 0, bottom: 0, width: 0, height: 0 })
    this.scroll.setRect({ top: 0, bottom: 0, width: 0, height: 0 })
    this.flow = new FixtureElement({ 'data-chat-flow': '' })
    this.scroll = new FixtureElement({ 'data-conversation-scroll': '' }, { top: 76, bottom: 1_279 })
    this.flow.setItems(items)
  }

  /** The active conversation root, as `querySelector` would find it. */
  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FixtureElement[] {
    this.observed.push(selector)
    if (selector === '[data-chat-flow]') return [this.flow]
    if (selector === '[data-conversation-scroll]') return [this.scroll]
    if (selector === "[data-phase='active']") return [this.flow]
    const attribute = /^\[([a-z-]+)\]$/.exec(selector)
    if (attribute?.[1] !== undefined) {
      return this.flow.querySelectorAll(`[${attribute[1]}]`)
    }
    throw new Error(`tests/client-fixture: unimplemented selector ${selector}`)
  }

  /** The `Document` the client half reads, as this fixture presents it. */
  asDocument(): Document {
    return {
      visibilityState: this.visibleState,
      hasFocus: () => this.focused,
      documentElement: this.documentElement,
      querySelector: (selector: string) => this.querySelector(selector),
      querySelectorAll: (selector: string) => this.querySelectorAll(selector),
    } as unknown as Document
  }

  /** The `VisibilityDeps` a real page would build from this document. */
  deps(): VisibilityDeps {
    return {
      document: this,
      flowElement: this.flow,
      scrollElement: this.scroll,
      viewportHeight: () => this.viewportHeight,
      rectOf: element => element.getBoundingClientRect(),
    }
  }
}

/** Build one flow item. */
export function item(
  turn: number,
  kind: string,
  rect: Partial<RectFace> = {},
): FixtureElement {
  return new FixtureElement({ 'data-chat-turn': String(turn), 'data-chat-flow-kind': kind }, rect)
}

/** Build one pending notice as the host would advertise it. */
export function notice(
  noticeId: string,
  turn: number,
  overrides: Partial<PendingNotice> = {},
): PendingNotice {
  return {
    noticeId,
    sessionId: 'session-1',
    runId: `run-${turn}`,
    targetTurnRef: String(turn),
    reason: 'completed',
    completedAt: 1_000 + turn,
    state: 'pending',
    ...overrides,
  }
}

/** Resolve after `ms`, letting real timers in the client under test run. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Poll until `check` holds, or fail with a label.
 *
 * @param check - predicate to poll.
 * @param label - what was being awaited.
 * @param timeoutMs - how long to keep polling.
 */
export async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * A `HostObservable` double whose value the test can move.
 *
 * The three ways the host changes a value are kept separate on purpose:
 * `set()` moves it silently, `notify()` announces a change nobody made, and
 * `emit()` does both. Separating them is what lets a test pin the client's
 * reaction to "the source emitted" apart from "the session actually moved" —
 * the two are not the same event, and the client must not treat them as one.
 *
 * @typeParam T - the snapshot type.
 */
export class FakeObservable<T> {
  private value: T
  private readonly listeners = new Set<() => void>()
  /** How many times the client subscribed. */
  subscribeCount = 0
  /** How many times the client's unsubscribe was called. */
  unsubscribeCount = 0

  constructor(value: T) {
    this.value = value
  }

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.subscribeCount += 1
    this.listeners.add(listener)
    return () => {
      this.unsubscribeCount += 1
      this.listeners.delete(listener)
    }
  }

  /** Replace the value without notifying anyone. */
  set(next: T): void {
    this.value = next
  }

  /** Notify the listeners without changing the value. */
  notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Replace the value and notify, as the host does on a real change. */
  emit(next: T): void {
    this.set(next)
    this.notify()
  }
}
