/**
 * Browser half of `dsh-pet-bridge`.
 *
 * This half is intentionally tiny and **dependency-free**: it renders no UI, so
 * it never touches `react` or the frozen module table, and its bundle is
 * provably free of runtime imports.
 *
 * What it does:
 *
 * 1. Learns the session the user is actually looking at from the client
 *    `sessions` service, and keeps the host's per-tab focus lease fresh.
 * 2. Asks the host which notices are still unconfirmed for that session.
 * 3. Watches the finished turn's own DOM row through the L1→L3 ladder in
 *    `visibility.ts`, and reports `/seen` only when L3 holds.
 *
 * What it deliberately does **not** do: mark anything seen from L1/L2 alone, or
 * from a query succeeding. Those are telemetry and liveness, not observation.
 *
 * @module dsh-pet-bridge/client
 */

import { BROWSER_ROUTES, PROTOCOL_VERSION } from '../protocol.js'
import type { NoticesPayload, PendingNotice, SeenResponse } from '../protocol.js'
import { VisibilityTracker, createDomFace } from './visibility.js'

/** Services this half needs. These are runtime package names, not values. */
export const inject = ['sessions', 'connection']

/** The client `sessions` service slice this plugin reads. */
export interface SessionsFace {
  list: {
    getSnapshot(): {
      /** Currently selected session id, or null/undefined when none. */
      current?: string | null
      byId: Record<string, { title?: string, running?: boolean, origin?: 'subagent' } | undefined>
    }
  }
}

/** Context capabilities this half uses. */
export interface ClientContext {
  sessions: SessionsFace
  effect: (callback: () => (() => void | Promise<void>) | void) => unknown
  logger?: { info?: (message: string) => void, warn?: (message: string) => void }
}

/** How often the ladder is evaluated while the page is focused, in ms. */
const DWELL_TICK_MS = 300

/** How often pending notices are re-queried while the page is focused. */
const NOTICES_POLL_MS = 1_000

/** How often the focus lease is refreshed while the page stays focused. */
const LEASE_REFRESH_MS = 5_000

/** Per-tab-instance id key; survives reloads of the same tab. */
const TAB_ID_KEY = 'dsh-pet-bridge:tab-id'

/**
 * Ask a timer not to hold the process open.
 *
 * In the page these are plain numbers; under Node's test harness the same code
 * path may receive a `Timeout` object. Both are fine — this only silences the
 * "unref if it exists" difference without a cast at every call site.
 *
 * @param timer - value returned by `setTimeout`/`setInterval`.
 */
function unref(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const candidate = timer as { unref?: () => void }
    candidate.unref?.()
  }
}

/** Read or mint this tab's opaque id. */
function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY)
    if (existing !== null && existing !== '') return existing
    const minted = globalThis.crypto?.randomUUID?.()
      ?? `tab-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(TAB_ID_KEY, minted)
    return minted
  } catch {
    // Storage can be blocked; a per-page id is still enough to key a lease.
    return `tab-${Math.random().toString(36).slice(2)}`
  }
}

/** Parse the numeric turn out of a `targetTurnRef`, or null. */
function turnOf(notice: PendingNotice): number | null {
  if (notice.targetTurnRef === null) return null
  const turn = Number(notice.targetTurnRef)
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/** POST JSON, ignoring every failure: the page must never break because of this plugin. */
async function postJson(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
    if (!response.ok) return null
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Client plugin entry point.
 *
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const log = (message: string): void => { ctx.logger?.info?.(`dsh-pet-bridge: ${message}`) }
  const id = tabId()
  const dom = createDomFace()
  const tracker = new VisibilityTracker({ dom, dwellMs: 1500 })
  /** Notices the host reported as unconfirmed for the current session. */
  let pending: PendingNotice[] = []
  /** Notice ids whose report already went out, so a re-render cannot resend. */
  const reported = new Set<string>()
  let currentSessionId: string | null = null
  let disposed = false

  const snapshot = (): { sessionId: string | null, title: string | null } => {
    try {
      const state = ctx.sessions.list.getSnapshot()
      const sessionId = typeof state.current === 'string' && state.current !== '' ? state.current : null
      const title = sessionId === null ? null : (state.byId[sessionId]?.title ?? null)
      return { sessionId, title }
    } catch {
      return { sessionId: null, title: null }
    }
  }

  /** Coalesce bursts: a scroll frame must not become a request storm. */
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (!disposed) void refreshNotices()
    }, 120)
    unref(refreshTimer)
  }

  /** Send the current L1/L2 state so the host can maintain this tab's lease. */
  const reportVisibility = (): void => {
    const { sessionId, title } = snapshot()
    currentSessionId = sessionId
    void postJson(BROWSER_ROUTES.visibility, {
      v: PROTOCOL_VERSION,
      tabId: id,
      sessionId,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      title,
    })
  }

  /** Pull the unconfirmed notices for the current session. */
  const refreshNotices = async (): Promise<void> => {
    const { sessionId } = snapshot()
    if (sessionId === null) {
      pending = []
      tracker.setTarget(null)
      return
    }
    if (sessionId !== currentSessionId) {
      // A session switch invalidates every previous observation immediately.
      currentSessionId = sessionId
      reported.clear()
      tracker.setTarget(null)
    }
    try {
      const response = await fetch(
        `${BROWSER_ROUTES.notices}?sessionId=${encodeURIComponent(sessionId)}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) return
      const payload = await response.json() as NoticesPayload
      pending = Array.isArray(payload.notices) ? payload.notices : []
    } catch {
      return
    }
    const next = pending.find(notice => turnOf(notice) !== null && !reported.has(notice.noticeId))
    if (next === undefined) {
      tracker.setTarget(null)
      return
    }
    const turn = turnOf(next)
    if (turn === null) return
    tracker.setTarget({ sessionId, noticeId: next.noticeId, turn })
  }

  /** Report an L3 observation; the host independently re-validates it. */
  const reportSeen = async (noticeId: string, sessionId: string): Promise<void> => {
    const notice = pending.find(candidate => candidate.noticeId === noticeId)
    if (notice === undefined) return
    reported.add(noticeId)
    const response = await postJson(BROWSER_ROUTES.seen, {
      v: PROTOCOL_VERSION,
      noticeId,
      runId: notice.runId,
      sessionId,
      tabId: id,
      observed: true,
    })
    const accepted = (response as SeenResponse | null)?.accepted === true
    if (!accepted) {
      // The host is authoritative and refused; stop retrying this notice until
      // the next query hands us a fresh list.
      log(`observation for ${noticeId} refused: ${String((response as SeenResponse | null)?.reason ?? 'unknown')}`)
      return
    }
    pending = pending.filter(candidate => candidate.noticeId !== noticeId)
    tracker.setTarget(null)
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */

  const onAnyStateChange = (): void => {
    reportVisibility()
    void refreshNotices()
  }

  const onUnload = (): void => {
    // Best-effort lease withdrawal; a tab that vanishes without this is covered
    // by the host's lease TTL.
    const { sessionId, title } = snapshot()
    const body = JSON.stringify({
      v: PROTOCOL_VERSION,
      tabId: id,
      sessionId,
      visible: false,
      focused: false,
      title,
    })
    try {
      if (typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(BROWSER_ROUTES.visibility, new Blob([body], { type: 'application/json' }))
        return
      }
    } catch {
      // Fall through to the fetch path.
    }
    void fetch(BROWSER_ROUTES.visibility, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined)
  }

  ctx.effect(() => {
    const listeners: Array<{ event: string, listener: EventListener }> = [
      { event: 'focus', listener: onAnyStateChange },
      { event: 'blur', listener: onAnyStateChange },
      { event: 'visibilitychange', listener: onAnyStateChange },
      { event: 'scroll', listener: scheduleRefresh },
      { event: 'pagehide', listener: onUnload },
    ]
    for (const { event, listener } of listeners) {
      window.addEventListener(event, listener, event === 'scroll' ? { capture: true, passive: true } : undefined)
    }
    // The DOM row for a finished turn appears asynchronously, so re-query on
    // mutations instead of assuming the first query already sees it.
    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => { scheduleRefresh() })
    observer?.observe(document.documentElement, { childList: true, subtree: true })

    const leaseTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) reportVisibility()
    }, LEASE_REFRESH_MS)
    unref(leaseTimer)

    const noticeTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refreshNotices()
    }, NOTICES_POLL_MS)
    unref(noticeTimer)

    const dwellTimer = setInterval(() => {
      if (disposed) return
      const result = tracker.update(document)
      if (result.report === null) return
      void reportSeen(result.report.noticeId, result.report.sessionId)
    }, DWELL_TICK_MS)
    unref(dwellTimer)

    reportVisibility()
    void refreshNotices()
    log('client runtime started')

    return () => {
      disposed = true
      clearInterval(leaseTimer)
      clearInterval(noticeTimer)
      clearInterval(dwellTimer)
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      observer?.disconnect()
      for (const { event, listener } of listeners) {
        window.removeEventListener(event, listener, event === 'scroll' ? { capture: true } : undefined)
      }
      tracker.setTarget(null)
    }
  })
}
