/**
 * The page half's decisions, kept free of DOM, timers, and `fetch`.
 *
 * `index.ts` is the wiring: it owns listeners, timers and requests. Everything
 * it has to *decide* lives here, as a pure function of values it already holds,
 * so the browser suite can drive the shipping logic instead of a copy of its
 * rules. The decisions encoded here are the defects this round fixes:
 *
 * - **which notice to watch** — the oldest *visible* one, never letting a
 *   notice that is scrolled out of view block a newer one that is on screen
 *   (D3);
 * - **whether a refused report may be retried** — a transient refusal must not
 *   blacklist a notice forever, while a terminal one must stop the retry loop
 *   (D4);
 * - **what a report response means** — accepted, refused-for-now, or finished;
 * - **which session the user is looking at** — one ordered chain over the four
 *   places 0.1.5 and 0.2.0 keep it, taking the first non-empty answer, so a
 *   runtime which moves it again degrades instead of going blind.
 *
 * @module dsh-pet-bridge/client/decide
 */

import type { PendingNotice } from '../protocol.js'

/** One notice plus the turn number the page can match it against. */
export interface WatchCandidate {
  readonly notice: PendingNotice
  readonly turn: number
}

/** What the tracker should watch, once a notice has been chosen. */
export interface WatchTarget {
  readonly sessionId: string
  readonly noticeId: string
  readonly turn: number
}

/**
 * Refusal reasons after which retrying is pointless.
 *
 * These are terminal because the host has already reached a final answer about
 * the notice: it was closed by the user, or it never matched this run/session.
 * The request-shape reasons cannot improve either — the page would send the
 * same bytes again. Everything else (`no-effective-lease`, `tab-not-on-session`,
 * and a response that never arrived at all) is a race the page can win later.
 */
export const TERMINAL_SEEN_REASONS: ReadonlySet<string> = new Set([
  'already-dismissed',
  'unknown-notice',
  'run-mismatch',
  'session-mismatch',
  'observed-flag-missing',
  'incomplete-observation',
])

/** How the page must react to a `/seen` response. */
export type SeenOutcome = 'verified' | 'retry' | 'stop'

/**
 * Classify a `/seen` response.
 *
 * @param accepted - the host's `accepted` flag, or undefined when the request
 *   never produced a parsable response.
 * @param reason - the host's machine-readable refusal reason, if any.
 * @returns `verified` for an accepted observation, `stop` for a terminal
 *   refusal, and `retry` for anything that may still succeed.
 */
export function classifySeenOutcome(accepted: boolean, reason?: string): SeenOutcome {
  if (accepted) return 'verified'
  // A refusal with no reason came from a malformed body, not from the
  // observation checks; the identifiers matched when it was sent, so a
  // re-send is worth one more try rather than a permanent block.
  if (reason === undefined || reason === '') return 'retry'
  return TERMINAL_SEEN_REASONS.has(reason) ? 'stop' : 'retry'
}

/** Parsed numeric turn of a notice, or null when unusable. */
export function turnOf(notice: PendingNotice): number | null {
  if (notice.targetTurnRef === null) return null
  const turn = Number(notice.targetTurnRef)
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/**
 * Notices the page is still allowed to report, in the order the host sent them
 * (oldest completion first).
 *
 * @param notices - the host's answer to `/pet-bridge/notices`.
 * @param blocked - notice ids already settled, or terminally refused.
 * @returns watchable candidates.
 */
export function watchableCandidates(
  notices: readonly PendingNotice[],
  blocked: ReadonlySet<string>,
): WatchCandidate[] {
  const rows: WatchCandidate[] = []
  for (const notice of notices) {
    if (blocked.has(notice.noticeId)) continue
    const turn = turnOf(notice)
    if (turn === null) continue
    rows.push({ notice, turn })
  }
  return rows
}

/** Outcome of picking a watch target. */
export interface SelectionResult {
  readonly target: WatchTarget | null
  /** Whether the chosen target's result is on screen right now. */
  readonly visible: boolean
  /** Candidates that were eligible, for diagnostics. */
  readonly considered: number
}

/**
 * Choose which notice to watch.
 *
 * A notice whose result is scrolled out of view cannot be confirmed by the
 * user, so it must not hold the watch slot: a newer notice that *is* on screen
 * is chosen instead (D3). When nothing is on screen there is nothing better to
 * wait for, so the oldest candidate is watched and its dwell simply starts when
 * the user scrolls to it.
 *
 * @param candidates - watchable candidates, oldest first.
 * @param sessionId - session the page is currently showing.
 * @param isVisible - predicate saying whether a turn's result is on screen.
 * @returns the target to watch, whether it is currently visible, and how many
 *   candidates were considered.
 */
export function selectWatchTarget(
  candidates: readonly WatchCandidate[],
  sessionId: string,
  isVisible: (turn: number) => boolean,
): SelectionResult {
  let fallback: WatchCandidate | null = null
  for (const candidate of candidates) {
    if (fallback === null) fallback = candidate
    if (isVisible(candidate.turn)) {
      return {
        target: { sessionId, noticeId: candidate.notice.noticeId, turn: candidate.turn },
        visible: true,
        considered: candidates.length,
      }
    }
  }
  if (fallback === null) return { target: null, visible: false, considered: 0 }
  return {
    target: { sessionId, noticeId: fallback.notice.noticeId, turn: fallback.turn },
    visible: false,
    considered: candidates.length,
  }
}

/** Per-notice retry bookkeeping for `/seen` reports. */
export interface AttemptGate {
  /** Whether a report for `noticeId` may be sent at `at`. */
  readonly canAttempt: (noticeId: string, at: number) => boolean
  /** Record that a report for `noticeId` was sent at `at`. */
  readonly remember: (noticeId: string, at: number) => void
  /** Drop the record so the next attempt is immediate. */
  readonly forget: (noticeId: string) => void
  /** Forget everything; used when the session changes. */
  readonly clear: () => void
}

/**
 * Build a retry gate.
 *
 * The gate is a rate limit, not a blacklist: the dwell clock has to re-accumulate
 * before a notice is reported again, and this stops the extra attempt that a
 * 300 ms tick could otherwise fire while the clock is still satisfied.
 *
 * @param cooldownMs - minimum spacing between two attempts for one notice.
 * @returns the gate.
 */
export function createAttemptGate(cooldownMs: number): AttemptGate {
  const lastAttemptAt = new Map<string, number>()
  return {
    canAttempt: (noticeId, at) => {
      const last = lastAttemptAt.get(noticeId)
      return last === undefined || at - last >= cooldownMs
    },
    remember: (noticeId, at) => { lastAttemptAt.set(noticeId, at) },
    forget: (noticeId) => { lastAttemptAt.delete(noticeId) },
    clear: () => { lastAttemptAt.clear() },
  }
}

/**
 * Validate the dwell threshold the host advertises.
 *
 * A bad value must never disable confirmation altogether, so anything that is
 * not a finite, non-negative number falls back to the caller's default.
 *
 * @param value - raw `seenDwellMs` from the notices payload.
 * @param fallbackMs - value to use when the advertised one is unusable.
 * @returns a usable threshold in ms.
 */
export function resolveDwellMs(value: unknown, fallbackMs: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallbackMs
}

/* -------------------------------------------------------------------------- *
 * Which session the user is looking at
 *
 * 0.2.0 moved this answer: `sessions.list.current` is gone from its snapshot and
 * the current session now lives on the `uiSession` service. The chain below is
 * the whole compatibility story — there is no version sniffing anywhere, only
 * "which read answers on this runtime" — and `reader` is what makes a future
 * move visible instead of silent.
 * -------------------------------------------------------------------------- */

/**
 * A host-provided value source.
 *
 * Both runtimes hand the current-session binding out in this shape
 * (`HostObservable` in `@deepseek-ai/dsh-client-ui-slots`), and both return an
 * unsubscribe function from `subscribe`.
 */
export interface ObservableView<T> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

/** A session binding; `key` is undefined when there is no current session. */
export interface SessionBindingLike {
  key?: string
}

/**
 * The slice of the client `uiSession` service this half reads.
 *
 * `adapter.current` is the public face on **both** versions; `current` is the
 * alias 0.2.0 added for the same object. Neither is declared in `inject`, so a
 * runtime that renames or drops the service only costs us the watch ladder
 * (see `index.ts`), never the client half itself.
 */
export interface UiSessionFace {
  adapter?: { current?: ObservableView<SessionBindingLike> }
  current?: ObservableView<SessionBindingLike>
}

/** One `sessions.list` row, widened to the 0.2.0 shape. */
export interface SessionRow {
  title?: string
  running?: boolean
  origin?: 'subagent'
  /** Retention counters; `mainView > 0` means the main view is showing it. */
  retainedBy?: { mainView?: number }
}

/** The `sessions.list` snapshot both runtimes hand out. */
export interface SessionsListSnapshot {
  /** Present on 0.1.5, absent on 0.2.0. */
  current?: string | null
  byId: Record<string, SessionRow | undefined>
}

/**
 * The client `sessions` service slice this plugin reads.
 *
 * `list` is declared as the observable it is rather than as a bare getter: reads
 * 2 and 3 answer from this one source, so this is also the object a session
 * switch is noticed through.
 */
export interface SessionsFace {
  list: ObservableView<SessionsListSnapshot>
}

/** Which read in the chain produced the session id; `-1` when none did. */
export type SessionReaderIndex = 0 | 1 | 2 | 3 | -1

/** The current session as this page sees it. */
export interface ResolvedCurrentSession {
  readonly sessionId: string | null
  readonly title: string | null
  /** Hit index of the read that answered; the drift signal to report upstream. */
  readonly reader: SessionReaderIndex
}

/** Everything the chain may read; both fields tolerate absence. */
export interface CurrentSessionSource {
  /** Result of `ctx.get('uiSession')`, or undefined when it is absent. */
  readonly uiSession?: unknown
  readonly sessions?: SessionsFace
}

/** A non-empty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Read the session id out of an observable binding.
 *
 * @param read - thunk returning the observable. It is called inside the guard
 *   because reaching the observable is itself a read that may throw (the
 *   services are proxies and a torn-down fiber can leave a getter behind).
 * @returns the binding's `key`, or null when the source is missing, malformed,
 *   or throws.
 */
function bindingKey(read: () => unknown): string | null {
  try {
    const view = read()
    if (typeof view !== 'object' || view === null) return null
    const snapshot = (view as ObservableView<unknown>).getSnapshot()
    if (typeof snapshot !== 'object' || snapshot === null) return null
    return nonEmptyString((snapshot as SessionBindingLike).key)
  } catch {
    return null
  }
}

/** Take the `sessions.list` snapshot once, or null when it cannot be read. */
function sessionList(sessions: SessionsFace | undefined): SessionsListSnapshot | null {
  try {
    const snapshot = sessions?.list.getSnapshot()
    return typeof snapshot === 'object' && snapshot !== null ? snapshot : null
  } catch {
    return null
  }
}

/**
 * The id of the first row the main view retains.
 *
 * This is the read the product itself uses (`ui-session` and `ui-layout`), so
 * the order is the host's own `byId` key order rather than one we invent.
 *
 * @param list - the `sessions.list` snapshot, if it could be read.
 * @returns that row's id, or null.
 */
function retainedSessionId(list: SessionsListSnapshot | null): string | null {
  try {
    for (const [id, row] of Object.entries(list?.byId ?? {})) {
      if ((row?.retainedBy?.mainView ?? 0) > 0) return nonEmptyString(id)
    }
    return null
  } catch {
    return null
  }
}

/** The title of a resolved session, taken from the same snapshot as its id. */
function sessionTitle(list: SessionsListSnapshot | null, sessionId: string): string | null {
  try {
    const title = list?.byId[sessionId]?.title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/**
 * Find the session the user is looking at.
 *
 * Reads are tried in order and the first non-empty id wins, so a runtime that
 * loses one source degrades to the next instead of going blind:
 *
 * | `reader` | read | 0.1.5 | 0.2.0 |
 * | --- | --- | --- | --- |
 * | 0 | `uiSession.adapter.current.getSnapshot().key` | yes | yes |
 * | 1 | `uiSession.current.getSnapshot().key` | — | yes |
 * | 2 | `sessions.list.getSnapshot().current` | yes | — |
 * | 3 | the `byId` row with `retainedBy.mainView > 0` | — | yes |
 *
 * Every read is guarded on its own, so a throwing source costs one step rather
 * than the whole chain. Nothing here throws, and nothing here subscribes: this
 * function only answers "which session", the caller owns observation.
 *
 * @param source - the `uiSession` value and the `sessions` service.
 * @returns the session id, its title, and which read found it (`-1` if none).
 */
export function resolveCurrentSession(source: CurrentSessionSource): ResolvedCurrentSession {
  const ui = source.uiSession as UiSessionFace | undefined
  // One snapshot serves the `current` read, the `retainedBy` fallback and the
  // title, so an id and its title can never come from different revisions.
  const list = sessionList(source.sessions)
  const readers: ReadonlyArray<readonly [SessionReaderIndex, () => string | null]> = [
    // 0: the public face both runtimes expose.
    [0, () => bindingKey(() => ui?.adapter?.current)],
    // 1: 0.2.0's alias for the same object; survives `adapter` being renamed.
    [1, () => bindingKey(() => ui?.current)],
    // 2: the pre-0.2 read, kept as the fallback 0.1.5 answers with.
    [2, () => nonEmptyString(list?.current)],
    // 3: last resort, and the read the host's own UI uses.
    [3, () => retainedSessionId(list)],
  ]
  for (const [reader, read] of readers) {
    const sessionId = read()
    if (sessionId !== null) {
      return { sessionId, title: sessionTitle(list, sessionId), reader }
    }
  }
  return { sessionId: null, title: null, reader: -1 }
}

/** Narrow an unknown value to a readable observable, or null. */
function observableOf(value: unknown): ObservableView<unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return typeof (value as { getSnapshot?: unknown }).getSnapshot === 'function'
    ? value as ObservableView<unknown>
    : null
}

/**
 * Which observable to follow so a session change is noticed without polling.
 *
 * `resolveCurrentSession()` answers *which* session is current and reports the
 * hit index; this answers the separate question of *what to subscribe to* for
 * that hit. Reads 2 and 3 share one source (`sessions.list`) and therefore one
 * subscription; reads 0 and 1 each name their own observable (`FIX-DESIGN`
 * §5.2). Nothing here subscribes — observation is the caller's, the same split
 * as everywhere else in this module — and nothing throws: an unreachable source,
 * or a `-1` hit, means "no observable to follow". A missing subscription is
 * never a correctness problem, only a slower notice of the switch.
 *
 * @param source - the same source `resolveCurrentSession()` was given.
 * @param reader - the hit index that function returned.
 * @returns the observable the hit index came from, or null when there is none.
 */
export function currentSessionObservable(
  source: CurrentSessionSource,
  reader: SessionReaderIndex,
): ObservableView<unknown> | null {
  try {
    if (reader === 0 || reader === 1) {
      const ui = source.uiSession as UiSessionFace | undefined
      return observableOf(reader === 0 ? ui?.adapter?.current : ui?.current)
    }
    if (reader === 2 || reader === 3) return observableOf(source.sessions?.list)
    return null
  } catch {
    return null
  }
}
