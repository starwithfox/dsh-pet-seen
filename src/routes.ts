/**
 * Browser-facing routes, mounted on the DSH WebServer so the page can use
 * plain same-origin `fetch` (no extra port, no CORS, no new WebSocket).
 *
 * Three `exact` routes, one per action, each checking its own method. They are
 * kept separate rather than funnelled through one dispatcher so a wrong method
 * is refused per path and the registered route table stays self-describing.
 *
 * The visibility report is *telemetry*, not consent: nothing here can mark a
 * notice seen. Only `POST /seen`, after an L3 observation on the page, can do
 * that, and only while that tab still holds a live focus lease.
 *
 * The same report carries the page's **session-read diagnostics** (`reader` and
 * friends, the drift self-check, PL-EN-NW-06). They are stored on the lease and surfaced through
 * {@link BrowserRoutes.diagnostics} so a future DSH that moves the current
 * session again is visible in `GET /state` within seconds instead of surfacing
 * as "the popup never goes away".
 *
 * It also carries the page's **build identity** (the build handshake,
 * PL-EN-NW-02). The host stores it beside its own and publishes both; neither half ever
 * decides that the other is stale, which is what keeps this a statement of fact
 * rather than a verdict — `tools/probe-http.mjs` is the reader that judges.
 *
 * @module dsh-pet-seen/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BROWSER_ROUTES,
  MAX_BUILD_ID_LENGTH,
  MAX_BY_ID_COUNT,
  MAX_MESSAGE_LENGTH,
  MAX_REQUEST_BODY_BYTES,
  PROTOCOL_VERSION,
  clampText,
  isReaderIndex,
  isSameOriginLoopback,
} from './protocol.js'
import type {
  NoticeSnapshot,
  NoticesPayload,
  SeenResponse,
  SessionReaderIndex,
  TabDiagnostic,
} from './protocol.js'
import type { NoticeStore, SessionFacts } from './state.js'

/** A route registration handle as returned by the DSH WebServer. */
export type RouteDisposer = () => void

/** The slice of the DSH WebServer this plugin uses. */
export interface WebServerFace {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => RouteDisposer
}

/** Collaborators for the browser routes. */
export interface BrowserRoutesDeps {
  readonly store: NoticeStore
  readonly webServer: WebServerFace
  /** Milliseconds of continuous visibility the page must report before `/seen`. */
  readonly seenDwellMs: number
  /** How long a tab's focus lease survives without a refresh, in ms. */
  readonly leaseTtlMs: number
  /**
   * Called when an L3 observation was accepted. The host uses this to tell the
   * pet to cancel a popup it already raised. Fired only for accepted
   * observations, and only once per notice.
   */
  readonly onObserved?: (notice: NoticeSnapshot) => void
  /** Optional diagnostic sink. */
  readonly log?: (message: string) => void
}

/** One live focus lease per browser tab instance. */
interface Lease {
  /** Session the tab reported as current, or null when nothing is selected. */
  sessionId: string | null
  visible: boolean
  focused: boolean
  /** Epoch ms the lease was last refreshed. */
  at: number
  /**
   * The drift self-check fields (PL-EN-NW-06), last reported by this tab.
   *
   * Kept on the lease rather than in a second table because the lease is already
   * one row per tab with a TTL, which is what makes these bounded and
   * self-recycling. Null means "this tab has never reported one" — a tab whose
   * read failed reports `-1`, which is a value and not a null.
   */
  reader: SessionReaderIndex | null
  readerReason: string | null
  byIdCount: number | null
  /**
   * Build identity that tab's client half reported, or null when it never has.
   *
   * Kept next to the read diagnostics because it rides the same report and the
   * same lease, and therefore gets the same bounded lifetime for free. It is a
   * separate field rather than part of that group because the two arrived in
   * different steps and are read for different reasons: `reader` says whether
   * the drift self-check works, `buildId` says whether this page is even running
   * the same build as the host that is answering it.
   */
  buildId: string | null
}

/** A mounted set of browser routes. */
export interface BrowserRoutes {
  /** Dispose every registered route and the lease sweeper. */
  readonly dispose: () => void
  /** Recorded leases, for `/state` diagnostics and tests. */
  readonly leases: () => ReadonlyMap<string, Lease>
  /** Whether the given tab currently holds an effective focus lease. */
  readonly hasEffectiveLease: (tabId: string, at: number) => boolean
  /**
   * What every tab whose lease is still fresh last reported.
   *
   * Two facts per row, for two different questions: the read diagnostics (this
   * is the only carrier for a `reader === -1` reading, because the per-session
   * snapshot needs a session id and `-1` means there was none) and the client
   * half's build identity, which has no per-session home at all.
   */
  readonly diagnostics: () => readonly TabDiagnostic[]
  /** Mounted route paths, in registration order. */
  readonly paths: readonly string[]
}

/**
 * Default lease lifetime.
 *
 * The page reports on focus, visibility, and session changes — not on a timer —
 * so the lifetime is generous: it exists to expire a tab that vanished without
 * a `pagehide` report, not to police a heartbeat.
 */
export const DEFAULT_LEASE_TTL_MS = 15_000

/** How often expired leases are swept. */
const LEASE_SWEEP_MS = 2_000

/** Respond with JSON and close the response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  })
  res.end(encoded)
}

/** Read a request body with a hard size cap. */
async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true, text: string } | { ok: false, reason: string }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.byteLength
    if (total > MAX_REQUEST_BODY_BYTES) return { ok: false, reason: 'body-too-large' }
    chunks.push(buffer)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/** Parse a request body into a plain object, or null. */
function parseObject(text: string): Record<string, unknown> | null {
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Mount the browser routes.
 *
 * @param deps - collaborators and registration target.
 * @returns handles for disposer, leases, and mounted paths.
 */
export function mountBrowserRoutes(deps: BrowserRoutesDeps): BrowserRoutes {
  const log = deps.log ?? (() => {})
  const leases = new Map<string, Lease>()
  const disposers: RouteDisposer[] = []

  const hasEffectiveLease = (tabId: string, at: number): boolean => {
    const lease = leases.get(tabId)
    if (lease === undefined) return false
    if (at - lease.at > deps.leaseTtlMs) return false
    return lease.visible && lease.focused
  }

  /**
   * Session-read diagnostics of every tab whose lease has not gone stale.
   *
   * Freshness uses the same rule as {@link hasEffectiveLease} rather than the
   * sweeper's interval, so a tab stops being reported at exactly the moment it
   * stops being able to observe anything — and a test can assert the bound
   * without waiting for the two-second sweep.
   */
  const diagnostics = (): TabDiagnostic[] => {
    const now = Date.now()
    const rows: TabDiagnostic[] = []
    for (const [tabId, lease] of leases) {
      if (now - lease.at > deps.leaseTtlMs) continue
      rows.push({
        tabId,
        sessionId: lease.sessionId,
        reader: lease.reader,
        readerReason: lease.readerReason,
        byIdCount: lease.byIdCount,
        buildId: lease.buildId,
        at: lease.at,
      })
    }
    rows.sort((left, right) => right.at - left.at)
    return rows
  }

  /** Same-origin gate shared by all three routes. */
  const sameOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!isSameOriginLoopback(req.headers.origin, req.headers.host)) {
      log(`rejected ${req.method ?? '?'} ${req.url ?? '?'}: not same-origin loopback`)
      sendJson(res, 403, { v: PROTOCOL_VERSION, ok: false, reason: 'cross-origin' })
      return false
    }
    return true
  }

  disposers.push(deps.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTES.visibility,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { v: PROTOCOL_VERSION, ok: false, reason: 'method-not-allowed' })
        return
      }
      if (!sameOrigin(req, res)) return
      const raw = await readBody(req)
      if (!raw.ok) {
        sendJson(res, 413, { v: PROTOCOL_VERSION, ok: false, reason: raw.reason })
        return
      }
      const body = parseObject(raw.text)
      if (body === null || typeof body.tabId !== 'string' || body.tabId === '') {
        sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: 'invalid-visibility' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
      /*
       * Diagnostics are read as a unit, keyed on the read index: a page that
       * knows how to report one always reports the index, and pairing an index
       * from this report with a reason from an older one would manufacture a
       * fact nobody observed. A report that carries no index at all — an older
       * client, or the best-effort `pagehide` withdrawal — keeps the tab's last
       * real answer instead of blanking it.
       */
      const diagnostics = isReaderIndex(body.reader)
        ? {
            reader: body.reader,
            readerReason: clampText(
              typeof body.readerReason === 'string' ? body.readerReason : undefined,
              MAX_MESSAGE_LENGTH,
            ) ?? null,
            byIdCount: typeof body.byIdCount === 'number'
              && Number.isSafeInteger(body.byIdCount)
              && body.byIdCount >= 0
              ? Math.min(body.byIdCount, MAX_BY_ID_COUNT)
              : null,
          }
        : null
      /*
       * The build identity is read on its own rather than as part of the group
       * above: the two facts come from different steps, and a report that names
       * a build but no read index is a real (if unlikely) shape a future client
       * could send. A value that is missing, empty or not a string keeps the
       * tab's previous identity instead of blanking it — a withdrawal written by
       * an older client must not erase what a newer one already said.
       */
      const reportedBuild = clampText(
        typeof body.buildId === 'string' ? body.buildId : undefined,
        MAX_BUILD_ID_LENGTH,
      )
      const previous = leases.get(body.tabId)
      leases.set(body.tabId, {
        sessionId,
        visible: body.visible === true,
        focused: body.focused === true,
        at: Date.now(),
        reader: diagnostics === null ? previous?.reader ?? null : diagnostics.reader,
        readerReason: diagnostics === null ? previous?.readerReason ?? null : diagnostics.readerReason,
        byIdCount: diagnostics === null ? previous?.byIdCount ?? null : diagnostics.byIdCount,
        buildId: reportedBuild ?? previous?.buildId ?? null,
      })
      // The client snapshot is the only place a session title reliably exists;
      // the host records the *shape* here and never invents one.
      if (sessionId !== null) {
        const facts: SessionFacts = {}
        if (typeof body.title === 'string' || body.title === null) facts.title = body.title
        // `-1` means the page found no session, so a report that carries one
        // alongside a session id is self-contradictory: the reading is kept in
        // the tab diagnostics (where it says what the page actually saw) and
        // never written as a fact about this session.
        if (diagnostics !== null && diagnostics.reader !== -1) facts.reader = diagnostics.reader
        deps.store.recordSessionFacts(sessionId, facts, Date.now())
      }
      sendJson(res, 200, { v: PROTOCOL_VERSION, ok: true })
    },
  }))

  disposers.push(deps.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTES.notices,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { v: PROTOCOL_VERSION, ok: false, reason: 'method-not-allowed' })
        return
      }
      if (!sameOrigin(req, res)) return
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') {
        sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: 'missing-session' })
        return
      }
      const notices = deps.store.pendingFor(sessionId)
      // Both `pending` and `shown` notices are offered. A `shown` notice is one
      // the pet already displayed, and the page has to keep watching it: that
      // is how the popup gets retracted once the user reads the result.
      const payload: NoticesPayload = {
        v: PROTOCOL_VERSION,
        revision: deps.store.snapshotRevision,
        sessionId,
        notices: notices.map(notice => ({
          noticeId: notice.noticeId,
          sessionId: notice.sessionId,
          runId: notice.runId,
          targetTurnRef: notice.targetTurnRef,
          reason: notice.reason,
          completedAt: notice.completedAt,
          // `pending` vs `shown` is the difference between "the pet never
          // displayed this" and "it is on screen right now" — carrying it makes
          // the distinction visible in the payload itself, not only in `/state`.
          state: notice.state,
        })),
        seenDwellMs: deps.seenDwellMs,
      }
      sendJson(res, 200, payload)
    },
  }))

  disposers.push(deps.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTES.seen,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { v: PROTOCOL_VERSION, ok: false, reason: 'method-not-allowed' })
        return
      }
      if (!sameOrigin(req, res)) return
      const raw = await readBody(req)
      if (!raw.ok) {
        sendJson(res, 413, { v: PROTOCOL_VERSION, ok: false, reason: raw.reason })
        return
      }
      const body = parseObject(raw.text)
      if (body === null) {
        sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: 'body-not-object' })
        return
      }
      const noticeId = typeof body.noticeId === 'string' ? body.noticeId : ''
      const runId = typeof body.runId === 'string' ? body.runId : ''
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const tabId = typeof body.tabId === 'string' ? body.tabId : ''
      if (noticeId === '' || runId === '' || sessionId === '' || tabId === '') {
        sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: 'incomplete-observation' })
        return
      }
      /** Refuse and explain; the page logs the reason instead of retrying blindly. */
      const refuse = (reason: string): void => {
        const payload: SeenResponse = { v: PROTOCOL_VERSION, accepted: false, reason }
        sendJson(res, 200, payload)
      }
      // `observed: true` is required verbatim: a page that merely reports being
      // visible must not be able to retire a notice.
      if (body.observed !== true) {
        refuse('observed-flag-missing')
        return
      }
      if (!hasEffectiveLease(tabId, Date.now())) {
        refuse('no-effective-lease')
        return
      }
      const lease = leases.get(tabId)
      if (lease === undefined || lease.sessionId !== sessionId) {
        refuse('tab-not-on-session')
        return
      }
      const result = deps.store.applyObservation({ noticeId, runId, sessionId }, Date.now())
      if (!result.accepted) {
        refuse(result.reason ?? 'rejected')
        return
      }
      log(`notice ${noticeId} marked seen by tab ${tabId}`)
      // A `shown` notice was already delivered, so the pet has a popup to
      // cancel. A `pending` one was never delivered: the host advertises
      // `seen: true` on the completion instead, and there is nothing to retract.
      if (result.notice !== null && result.notice.delivered) deps.onObserved?.(result.notice)
      const payload: SeenResponse = { v: PROTOCOL_VERSION, accepted: true }
      sendJson(res, 200, payload)
    },
  }))

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [tabId, lease] of leases) {
      if (now - lease.at > deps.leaseTtlMs) leases.delete(tabId)
    }
  }, LEASE_SWEEP_MS)
  sweeper.unref?.()

  return {
    dispose: () => {
      clearInterval(sweeper)
      for (const dispose of disposers.splice(0)) dispose()
      leases.clear()
    },
    leases: () => leases,
    hasEffectiveLease,
    diagnostics,
    paths: [BROWSER_ROUTES.visibility, BROWSER_ROUTES.notices, BROWSER_ROUTES.seen],
  }
}
