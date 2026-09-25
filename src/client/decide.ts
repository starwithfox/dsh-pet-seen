/**
 * The page half's decisions, kept free of DOM, timers, and `fetch`.
 *
 * `index.ts` is the wiring: it owns listeners, timers and requests. Everything
 * it has to *decide* lives here, as a pure function of values it already holds,
 * so the browser suite can drive the shipping logic instead of a copy of its
 * rules. The three decisions encoded here are the three defects this round
 * fixes:
 *
 * - **which notice to watch** — the oldest *visible* one, never letting a
 *   notice that is scrolled out of view block a newer one that is on screen
 *   (D3);
 * - **whether a refused report may be retried** — a transient refusal must not
 *   blacklist a notice forever, while a terminal one must stop the retry loop
 *   (D4);
 * - **what a report response means** — accepted, refused-for-now, or finished.
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
