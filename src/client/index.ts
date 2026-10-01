/**
 * Browser half of `dsh-pet-bridge`.
 *
 * This half is intentionally tiny and **dependency-free**: it renders no UI, so
 * it never touches `react` or the frozen module table, and its bundle is
 * provably free of runtime imports.
 *
 * What it does:
 *
 * 1. Learns the session the user is actually looking at — `uiSession` when the
 *    runtime has it, the `sessions` service as the fallback — and keeps the
 *    host's per-tab focus lease fresh. Every actual switch bumps a generation,
 *    so a `notices` or `seen` result that lands after the user has moved on is
 *    dropped rather than applied to the session they left; following the source
 *    with `subscribe` only makes the switch noticed sooner.
 * 2. Asks the host which notices are still unconfirmed for that session.
 * 3. Watches the finished turn through the L1→L3 ladder in `visibility.ts`, and
 *    reports `/seen` only when L3 holds — refreshing the focus lease first, so a
 *    report cannot be refused for a lease that the page simply had not renewed
 *    yet.
 *
 * Every decision it makes is in `decide.ts`; this file is only the wiring.
 *
 * @module dsh-pet-bridge/client
 */

import { BROWSER_ROUTES, PROTOCOL_VERSION } from '../protocol.js'
import type { NoticesPayload, PendingNotice, SeenResponse } from '../protocol.js'
import {
  classifySeenOutcome,
  createAttemptGate,
  currentSessionObservable,
  resolveCurrentSession,
  resolveDwellMs,
  selectWatchTarget,
  watchableCandidates,
} from './decide.js'
import type { ObservableView, ResolvedCurrentSession, SessionsFace } from './decide.js'
import { VisibilityTracker, createVisibilityDeps } from './visibility.js'

/** Services this half needs. These are runtime package names, not values. */
export const inject = ['sessions', 'connection']

/**
 * The service faces this half reads are declared next to the decisions that use
 * them (`decide.ts`), so the pure chain and the wiring cannot drift apart.
 */
export type { SessionsFace }

/**
 * Context capabilities this half uses.
 *
 * `get` is cordis' reflective service lookup. `uiSession` is deliberately **not**
 * in `inject`: a runtime that lacks or renames it must only cost us the watch
 * ladder, never the whole client half (no lease, no visibility reporting).
 */
export interface ClientContext {
  sessions: SessionsFace
  get?: (name: string) => unknown
  effect: (callback: () => (() => void | Promise<void>) | void) => unknown
  logger?: { info?: (message: string) => void, warn?: (message: string) => void }
}

/** How often the ladder is evaluated while the page is focused, in ms. */
const DWELL_TICK_MS = 300

/** How often pending notices are re-queried while the page is focused. */
const NOTICES_POLL_MS = 1_000

/**
 * Floor between two `/notices` requests, in ms.
 *
 * Mutations during streaming used to schedule one query per 120 ms burst on top
 * of the 1 s poll, which measured at roughly two requests per second on a real
 * page. The floor keeps scroll, session switches and a new result appearing
 * responsive without letting a re-rendering conversation set the pace.
 */
const NOTICES_MIN_INTERVAL_MS = 500

/** How often the focus lease is refreshed while the page stays focused. */
const LEASE_REFRESH_MS = 5_000

/** Fallback dwell threshold, used until the host advertises its own. */
const DEFAULT_SEEN_DWELL_MS = 1_500

/**
 * Minimum spacing between two `/seen` attempts for the same notice, in ms.
 *
 * The dwell clock is the real rate limiter — a retry has to earn L3 again — so
 * this only stops the extra attempt a 300 ms tick could fire while the clock is
 * still satisfied, and bounds what a persistently failing host can be asked.
 * Kept short so a refusal costs the user a couple of seconds of cancellation,
 * not a minute.
 */
export const SEEN_RETRY_COOLDOWN_MS = 2_000

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

/**
 * Delay before the next `/notices` query, honouring a floor between requests.
 *
 * @param now - current epoch ms.
 * @param lastAt - epoch ms of the last query, or null when there never was one.
 * @param minIntervalMs - floor between two queries.
 * @param baseDelayMs - coalescing delay for the triggering burst.
 * @returns milliseconds to wait before querying.
 */
export function nextRefreshDelay(
  now: number,
  lastAt: number | null,
  minIntervalMs: number,
  baseDelayMs: number,
): number {
  if (lastAt === null) return baseDelayMs
  const elapsed = now - lastAt
  return elapsed >= minIntervalMs ? baseDelayMs : minIntervalMs - elapsed
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
  /**
   * Notice ids this page has settled or been terminally refused for.
   *
   * Cleared on a session switch, because the host list is the authority again
   * at that point. A merely *transient* refusal never lands here — that is D4:
   * a race must not blacklist a notice for the life of the page.
   */
  const blocked = new Set<string>()
  const attempts = createAttemptGate(SEEN_RETRY_COOLDOWN_MS)
  const tracker = new VisibilityTracker({
    deps: createVisibilityDeps(),
    dwellMs: DEFAULT_SEEN_DWELL_MS,
    // Pacing lives here, dwell lives in the tracker. A notice refused for a
    // reason that may not repeat is reported again as soon as the cooldown has
    // passed and the user has kept the result on screen.
    canReport: target => attempts.canAttempt(target.noticeId, Date.now()),
  })
  /** Continuous-visibility threshold currently in force, in ms. */
  let dwellMs = DEFAULT_SEEN_DWELL_MS
  /** Notices the host reported as unconfirmed for the current session. */
  let pending: PendingNotice[] = []
  let currentSessionId: string | null = null
  let disposed = false
  /**
   * Bumped whenever the current session actually changes.
   *
   * This is the invariant of `FIX-DESIGN` §5.1.4: a switch invalidates every
   * previous observation immediately. An async result that was launched for the
   * old session must therefore not be allowed to write state when it lands, and
   * comparing this counter is what makes that true. Following the source below
   * only narrows the window in which a switch is *noticed* — the counter is what
   * keeps a late response harmless even with no subscription at all.
   */
  let generation = 0
  /** The source currently followed, and how to stop following it. */
  let subscribedTo: ObservableView<unknown> | null = null
  let unsubscribeSource: (() => void) | null = null

  /**
   * Read `uiSession` reflectively, on every call.
   *
   * Not captured at `apply()` time and not in `inject`, because the service may
   * arrive late, be replaced by a reload, or never exist — and all three have to
   * mean "no current session", not "this half failed to start".
   */
  const readUiSession = (): unknown => {
    try {
      // Called as a method of `ctx` on purpose: the context is a proxy and `get`
      // is mixed in from `reflect`, so an unbound reference loses its receiver.
      return ctx.get?.('uiSession')
    } catch {
      return undefined
    }
  }

  /**
   * The session the user is looking at, its title, and which read found it.
   *
   * `reader` names which read answered, and is consumed twice: to pick the
   * source worth following (below) and, from step 5 on, as the drift signal
   * reported upstream. A failure here is an ordinary "no current session" (invariant: the
   * page never breaks because of this plugin).
   */
  const snapshot = (): ResolvedCurrentSession => {
    try {
      return resolveCurrentSession({ uiSession: readUiSession(), sessions: ctx.sessions })
    } catch {
      return { sessionId: null, title: null, reader: -1 }
    }
  }

  /* ------------------------------------------------------------------ *
   * Notice refresh
   * ------------------------------------------------------------------ */

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let lastRefreshAt: number | null = null

  /** Coalesce bursts, and keep a floor between two actual queries. */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null || disposed) return
    const delay = nextRefreshDelay(Date.now(), lastRefreshAt, NOTICES_MIN_INTERVAL_MS, 120)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (!disposed) void refreshNotices()
    }, delay)
    unref(refreshTimer)
  }

  /**
   * React to the followed source changing.
   *
   * Only an *actual* change clears anything. These observables also emit for
   * row-level edits — a title, a `running` flag — and treating every emission as
   * a switch would throw away the pending notices the user is still looking at.
   * `syncSession` is idempotent, so an emission that did not move the session
   * costs one snapshot read and one coalesced re-query.
   */
  const onSessionSourceChange = (): void => {
    syncSession()
    scheduleRefresh()
  }

  /**
   * Follow the source the winning read came from, so a switch is noticed in
   * milliseconds instead of at the next poll.
   *
   * Re-binding is identity-based: when the service is replaced (a reload hands
   * us a new `uiSession`, or the winning read moves to another source) the old
   * subscription is dropped and the new object is followed. A source without
   * `subscribe`, or none at all, is not a problem — the generation check in
   * `refreshNotices()` / `reportSeen()` has to hold either way.
   *
   * @param resolved - the session image whose `reader` won the chain.
   */
  const bindSessionSubscription = (resolved: ResolvedCurrentSession): void => {
    if (resolved.reader === -1) return
    const observable = currentSessionObservable(
      { uiSession: readUiSession(), sessions: ctx.sessions },
      resolved.reader,
    )
    if (observable === null || observable === subscribedTo) return
    if (typeof observable.subscribe !== 'function') return
    unsubscribeSource?.()
    subscribedTo = observable
    try {
      unsubscribeSource = observable.subscribe(() => { onSessionSourceChange() }) ?? null
    } catch {
      // A source that refuses to be observed still answers reads; the poll and
      // the generation check carry the correctness on their own.
      subscribedTo = null
      unsubscribeSource = null
    }
  }

  /**
   * Bring the page's idea of the current session up to date, bumping the
   * generation when it actually moved.
   *
   * One place owns both, because the previous code wrote `currentSessionId` from
   * two directions — `reportVisibility()` unconditionally, `refreshNotices()` in
   * its switch guard — and a switch could therefore be missed: the visibility
   * path set the id first, and the guard that was supposed to clear the watch
   * state then saw no change at all.
   *
   * @param resolved - a snapshot the caller already took, to avoid reading twice.
   * @returns the session image now in force.
   */
  const syncSession = (resolved: ResolvedCurrentSession = snapshot()): ResolvedCurrentSession => {
    if (resolved.sessionId !== currentSessionId) {
      generation += 1
      currentSessionId = resolved.sessionId
      // Everything observed belongs to the session the user has left. Clearing
      // `blocked` and `attempts` is deliberate: they are per-page bookkeeping
      // about a session that is no longer on screen, and the host list is the
      // authority again for the new one.
      pending = []
      blocked.clear()
      attempts.clear()
      tracker.setTarget(null)
      log(`current session is now ${resolved.sessionId ?? 'none'}`)
    }
    bindSessionSubscription(resolved)
    return resolved
  }

  /** Send the current L1/L2 state so the host can maintain this tab's lease. */
  const reportVisibility = async (): Promise<void> => {
    const { sessionId, title } = syncSession()
    await postJson(BROWSER_ROUTES.visibility, {
      v: PROTOCOL_VERSION,
      tabId: id,
      sessionId,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      title,
    })
  }

  /** Point the tracker at whichever unconfirmed notice is worth watching. */
  const retarget = (sessionId: string): void => {
    const selection = selectWatchTarget(
      watchableCandidates(pending, blocked),
      sessionId,
      // Prefer a notice whose result is on screen: an older notice scrolled out
      // of view must not hold the watch slot.
      turn => tracker.isTurnOnScreen(turn),
    )
    tracker.setTarget(selection.target)
  }

  /** Pull the unconfirmed notices for the current session. */
  const refreshNotices = async (): Promise<void> => {
    const { sessionId } = syncSession()
    const gen = generation
    if (sessionId === null) {
      // Nothing to ask about, and any request already in flight was voided by
      // the generation bump `syncSession` just made.
      pending = []
      tracker.setTarget(null)
      return
    }
    lastRefreshAt = Date.now()
    try {
      const response = await fetch(
        `${BROWSER_ROUTES.notices}?sessionId=${encodeURIComponent(sessionId)}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) return
      const payload = await response.json() as NoticesPayload
      // The invariant (FIX-DESIGN §5.1.4): a response is only good while nothing
      // moved. The generation catches a switch this page already noticed (by
      // subscription, event or timer); re-reading the source catches the one
      // that happened while this request was in flight and that no event has
      // observed yet. Either way the stale body must not touch `pending`, the
      // watch target, or the dwell threshold — it describes a session the user
      // has left. Re-syncing here adopts the new session straight away, and the
      // immediate re-query keeps it from waiting for the next poll.
      const current = snapshot()
      if (disposed || gen !== generation || current.sessionId !== sessionId) {
        if (!disposed && current.sessionId !== sessionId) {
          syncSession(current)
          scheduleRefresh()
        }
        return
      }
      pending = Array.isArray(payload.notices) ? payload.notices : []
      // The host owns the threshold; validate it and restart the clock when it
      // changes, so a slow dwell can never be defeated by time banked under the
      // previous, shorter one.
      const advertised = resolveDwellMs(payload.seenDwellMs, dwellMs)
      if (tracker.setDwellMs(advertised)) {
        dwellMs = advertised
        log(`dwell threshold now ${advertised} ms`)
      }
    } catch {
      return
    }
    retarget(sessionId)
  }

  /**
   * Report an L3 observation; the host independently re-validates it.
   *
   * The focus lease is refreshed first: coming back from another window, the
   * host may still be holding the `focused: false` report the page sent on the
   * way out, and reporting against it is refused for a lease that is merely old.
   * That refresh is also the one await in which the user can leave the session,
   * so the generation is captured before it and re-checked after — and, because
   * a switch can happen without this page noticing it yet, the source is
   * re-read as well. `refreshNotices()` answers the same question the same way;
   * the cached half alone only covers a switch that something already observed.
   */
  const reportSeen = async (noticeId: string, sessionId: string): Promise<void> => {
    const notice = pending.find(candidate => candidate.noticeId === noticeId)
    if (notice === undefined) return
    attempts.remember(noticeId, Date.now())
    const gen = generation
    await reportVisibility()
    // A silent switch — no subscription on this face, page hidden so the poll
    // cannot run, and no timer, event or mutation fired yet — leaves both the
    // generation and `currentSessionId` untouched, so neither cached value can
    // answer "is the user still there". Only the source can, and a stale body
    // must not be sent under the session that was left behind: the host answers
    // it with `session-mismatch` and blacklists the notice for the life of the
    // page. This is the reachable leak — the lease refresh above is itself what
    // adopts the new session, so by the time the POST would be built the body
    // carries the *new* id while the notice is one the host no longer holds for
    // it. Adopting the session the read found is what keeps the new one from
    // waiting for the next poll.
    const stillCurrent = snapshot()
    if (disposed || stillCurrent.sessionId !== sessionId) {
      // The user has left this session. Say nothing to the host, count no
      // failure, and do not re-arm: the observation is not wrong, it is simply
      // no longer about anything on screen. (`attempts` was cleared by the same
      // switch, so the remembered attempt costs nothing either.)
      if (!disposed) {
        syncSession(stillCurrent)
        scheduleRefresh()
      }
      return
    }
    const response = await postJson(BROWSER_ROUTES.seen, {
      v: PROTOCOL_VERSION,
      noticeId,
      runId: notice.runId,
      sessionId,
      tabId: id,
      observed: true,
    })
    // The POST is a second await, and landing an old session's verdict on the
    // new session's state is the cross-talk this guards: a `retarget(sessionId)`
    // with the old id would tag a new session's notice as the old one's, and the
    // host's `session-mismatch` refusal would then blacklist it for the life of
    // the page.
    //
    // Unlike the check above, this pair is defensive rather than demonstrated:
    // every interleaving that was probed for it (a switch, a removal, both while
    // the POST is open) is already caught by the cached values, because anything
    // that syncs the new session also bumps the generation — and the re-read adds
    // the same answer for a switch that somehow arrived without one. Kept for
    // symmetry with the first check, and on record as not being pinned by a
    // failing case; see `IMPL-LOG` §3b.
    if (disposed || gen !== generation || currentSessionId !== sessionId) return
    const afterPost = snapshot()
    if (disposed || afterPost.sessionId !== sessionId) {
      if (!disposed) {
        syncSession(afterPost)
        scheduleRefresh()
      }
      return
    }
    const outcome = classifySeenOutcome(
      (response as SeenResponse | null)?.accepted === true,
      (response as SeenResponse | null)?.reason,
    )
    if (outcome === 'retry') {
      // Not a verdict. Re-arm the target so the next qualifying dwell reports
      // again — a refusal must cost a couple of seconds, not the cancellation.
      log(`observation for ${noticeId} not accepted: ${String((response as SeenResponse | null)?.reason ?? 'no-response')}`)
      tracker.rearm()
      return
    }
    if (outcome === 'stop') {
      log(`observation for ${noticeId} refused: ${String((response as SeenResponse | null)?.reason ?? 'unknown')}`)
      blocked.add(noticeId)
    }
    pending = pending.filter(candidate => candidate.noticeId !== noticeId)
    retarget(sessionId)
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */

  const onAnyStateChange = (): void => {
    void reportVisibility()
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
    // The finished turn's rows appear asynchronously, so re-query on mutations
    // instead of assuming the first query already sees them. The floor in
    // `scheduleRefresh` is what keeps a streaming re-render from setting the
    // request rate.
    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => { scheduleRefresh() })
    observer?.observe(document.documentElement, { childList: true, subtree: true })

    const leaseTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void reportVisibility()
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

    void reportVisibility()
    void refreshNotices()
    log('client runtime started')

    return () => {
      disposed = true
      unsubscribeSource?.()
      unsubscribeSource = null
      subscribedTo = null
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
