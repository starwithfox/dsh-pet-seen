/**
 * Host half of `dsh-pet-seen`.
 *
 * Responsibilities, in the order they are set up in {@link apply}:
 *
 * 1. Subscribe to the harness event streams that describe *work*
 *    (`session/event`) and *run lifecycle* (`agent/status`) and fold them into
 *    per-session progress buckets plus one notice per finished run.
 * 2. Own the loopback control listener the pet talks to
 *    (`/hello`, `/state`, `/ack`).
 * 3. Push normalized events to the pet's own listener.
 * 4. Optionally mount the browser routes, but only when the DSH WebServer
 *    exists. That injection is *optional on purpose*: headless and CLI hosts
 *    have no WebServer, and the bridge's core must not fail to start there.
 *
 * The harness packages are imported for their types only. Their declarations
 * are resolved from the live DSH installation during type checking, and the
 * bundle carries no runtime dependency on them — see `tsconfig.check.json`.
 *
 * @module dsh-pet-seen
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUILD_ID,
  DEFAULT_CONTROL_PORT,
  DEFAULT_PET_PORT,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  clampTitle,
} from './protocol.js'
import type { NoticeSnapshot, PetEvent, PetEventName, StatePayload, TurnEndKind } from './protocol.js'
import { NoticeStore, buildEvent } from './state.js'
import type { RunCompletion } from './state.js'
import type {
  AgentErrorListener,
  AgentFace,
  AgentStatusListener,
  SessionEventFace,
  SessionEventListener,
  SessionFace,
} from './pins.js'
import { PetClient } from './pet-client.js'
import { startControlServer } from './control-server.js'
import type { ControlServer } from './control-server.js'
import { DEFAULT_LEASE_TTL_MS, mountBrowserRoutes } from './routes.js'
import type { BrowserRoutes } from './routes.js'

/*
 * The harness-shape faces and the compile-time pins that tie them to the real
 * declarations live in `./pins.ts`, which is the only module that references
 * DSH's internal types. They are re-exported here because they were part of this
 * module's surface before the move; `Assert` / `Satisfies` deliberately are not
 * — they are build-time machinery, not plugin contract.
 */
export type { AgentFace, PinnedHarnessShapes, SessionEventFace, SessionFace } from './pins.js'

/** Plugin name as the loader knows it. */
export const name = 'dsh-pet-seen'

/** Services this plugin waits for. `webServer` is *not* here; see {@link apply}. */
export const inject = ['agents', 'sessions']

/** Configuration schema; every default comes from the design document. */
export const Config = Schema.object({
  /** Loopback port for `/hello`, `/state`, `/ack`. */
  controlPort: Schema.number().default(DEFAULT_CONTROL_PORT),
  /**
   * Where to publish the handshake file. Empty means the shared
   * `~/.dsh/pet-bridge.json`. A `controlPort: 0` instance (tests, offline
   * tools) must point this at its own file, because otherwise it would
   * overwrite the credentials of the bridge that is actually serving DSH.
   */
  tokenFile: Schema.string().default(''),
  /** Port the pet listens on before it has handshaken. */
  petPort: Schema.number().default(DEFAULT_PET_PORT),
  /** Wait this long for a browser observation before pushing `completed`. */
  notifyDelayMs: Schema.number().default(2500),
  /** Per-request timeout when pushing to the pet. */
  petEventTimeoutMs: Schema.number().default(800),
  /** Grace for a `turn/end` that arrives after the idle signal. */
  idleGraceMs: Schema.number().default(1500),
  /** Continuous on-screen dwell the page requires before reporting `/seen`. */
  seenDwellMs: Schema.number().default(1500),
  /** Retained notices cap. */
  maxNotices: Schema.number().default(100),
  /** Retained notice age cap, in ms. */
  noticeTtlMs: Schema.number().default(24 * 60 * 60 * 1000),
  /** Whether session titles may be sent to the pet (titles echo user input). */
  includeTitle: Schema.boolean().default(true),
})

/** Resolved configuration. */
export type BridgeConfig = {
  controlPort: number
  tokenFile: string
  petPort: number
  notifyDelayMs: number
  petEventTimeoutMs: number
  idleGraceMs: number
  seenDwellMs: number
  maxNotices: number
  noticeTtlMs: number
  includeTitle: boolean
}

/** Context capabilities this plugin uses. */
export interface PluginContext {
  on: ((name: 'session/event', listener: SessionEventListener) => unknown) & {
    (name: 'agent/status', listener: AgentStatusListener): unknown
    (name: 'agent/error', listener: AgentErrorListener): unknown
  }
  effect: (callback: () => (() => void | Promise<void>) | void) => unknown
  inject: (names: readonly string[], callback: (scoped: {
    get: (name: string) => unknown
    effect: (callback: () => (() => void | Promise<void>) | void) => unknown
  }) => void) => unknown
  logger?: { warn: (message: string) => void, info: (message: string) => void }
}

/**
 * Narrow an arbitrary `turn/end` reason to the kinds the protocol names.
 *
 * Anything unrecognized — a malformed reason, an absent one, or a kind a newer
 * DSH added — becomes `'unknown'`, which is *not* a completion
 * ({@link completionDispatch}). Reporting success is the one outcome we must
 * never guess at: a wrong "your task finished" hides a failure, while a missing
 * popup is caught up through `/state`. The `_ReasonsCovered` pin makes the
 * "newer DSH added a kind" half of this a build failure rather than a runtime
 * default, so this branch only ever handles genuinely broken input.
 *
 * @param reason - raw `turn/end.data.reason`.
 * @returns the protocol-facing kind.
 */
function turnEndKind(reason: unknown): TurnEndKind {
  if (typeof reason !== 'object' || reason === null) return 'unknown'
  const kind = (reason as { kind?: unknown }).kind
  switch (kind) {
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'error':
    case 'forked':
    case 'max-tokens':
    case 'interrupted':
      return kind
    default:
      return 'unknown'
  }
}

/** Categories of failure the pet is allowed to see. */
export type ErrorCategory = 'network' | 'auth' | 'rate-limit' | 'aborted' | 'unknown'

/**
 * Map a failure to a closed category, forwarding nothing but the category.
 *
 * The raw value is read for `code` **shape** only, never echoed: harness error
 * text routinely restates the user's prompt, a tool argument or a remote
 * response body, and `README.md` §4.4 promises the pet never receives it. Only
 * membership in {@link ErrorCategory} crosses the wire.
 *
 * @param error - the raw value from `agent/error`.
 * @returns the category to report.
 */
function errorCategory(error: unknown): ErrorCategory {
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code === 'string' && code !== '') {
    const normalized = code.toLowerCase()
    if (/econn|etimedout|enotfound|eai_again|socket|network|dns|fetch/.test(normalized)) return 'network'
    if (/unauthor|forbidden|401|403|credential|api.?key/.test(normalized)) return 'auth'
    if (/rate.?limit|429|quota|too.?many.?requests/.test(normalized)) return 'rate-limit'
    if (/abort|cancel/.test(normalized)) return 'aborted'
  }
  return 'unknown'
}

/** Content-free one-liner for a failure, by category. */
function errorMessage(category: ErrorCategory): string {
  switch (category) {
    case 'network': return '运行出错：网络连接失败'
    case 'auth': return '运行出错：认证失败'
    case 'rate-limit': return '运行出错：请求过于频繁'
    case 'aborted': return '运行已中止'
    case 'unknown': return '运行出错'
  }
}

/**
 * Human-readable one-liner for a settled run, by turn-end kind.
 *
 * `forked` mints no notice, so nothing here reaches the pet through that path;
 * the line exists so the switch stays total over {@link TurnEndKind}.
 */
function completionMessage(kind: TurnEndKind): string {
  switch (kind) {
    case 'completed': return '任务完成'
    case 'max-tokens': return '达到输出上限后结束'
    case 'blocked': return '被阻塞，需要处理'
    case 'error': return '运行出错'
    case 'aborted': return '已中止'
    case 'interrupted': return '中断（会话恢复时补记）'
    case 'forked': return '分叉时截断（继承的前缀回合）'
    case 'unknown': return '运行结束（结束原因无法识别）'
  }
}

/** How one settled run maps onto the wire. */
interface CompletionDispatch {
  /** Normalized event name carrying this result. */
  readonly event: PetEventName
  /** Whether this reason mints a notice the pet may pop up and ack. */
  readonly notice: boolean
}

/**
 * Map a settled run's reason to its event, per the design's normalization table.
 *
 * The point of the split is that `reason` alone no longer has to carry the whole
 * meaning: a pet can act on the event name and use `reason` only for wording. In
 * particular `aborted` / `interrupted` / `forked` are **not** completions — they
 * mean the run stopped, so they mint no notice and nothing pops. `error` /
 * `blocked` do mint one, and the pet decides whether a failed run deserves a
 * popup; that is why a notice-bearing `error` carries `noticeId` while the
 * running-time failures (`tool/result`, `agent/error`) do not.
 *
 * @param kind - the settled run's reason.
 * @returns the event name and whether a notice is minted.
 */
export function completionDispatch(kind: TurnEndKind): CompletionDispatch {
  switch (kind) {
    case 'completed':
      return { event: 'completed', notice: true }
    // Truncated output still finished the run; `completionMessage` says so.
    case 'max-tokens':
      return { event: 'completed', notice: true }
    case 'error':
    case 'blocked':
      return { event: 'error', notice: true }
    // A fork cuts an unclosed prefix turn. The parent has not finished and the
    // child has not started, so there is nothing to announce: going `idle` is
    // the honest reading, and `interrupted` is reserved for "repaired after a
    // crash". Nothing pops (PL-PR-NW-04).
    case 'forked':
    case 'aborted':
    case 'interrupted':
    case 'unknown':
      return { event: 'idle', notice: false }
  }
}

/**
 * Plugin entry point.
 *
 * @param ctx - host plugin context.
 * @param config - resolved configuration.
 * @param testHooks - optional hooks the integration tests use to observe the
 *   plugin's own state: the bind outcome of the control listener and a consumed
 *   token. Absent in production; nothing here depends on it.
 */
export function apply(
  ctx: PluginContext,
  config: BridgeConfig,
  testHooks?: {
    readonly onReady?: (hooks: {
      readonly disposed: () => boolean
      /** Fires once, when the control listener succeeds or fails. */
      readonly onControlBound: (callback: (result:
        | { readonly ok: true, readonly port: number, readonly token: string }
        | { readonly ok: false, readonly reason: string }) => void) => void
    }) => void
  },
): void {
  const log = (message: string): void => {
    ctx.logger?.info?.(`dsh-pet-seen: ${message}`)
  }
  const warn = (message: string): void => {
    ctx.logger?.warn?.(`dsh-pet-seen: ${message}`)
  }

  const store = new NoticeStore({
    maxNotices: config.maxNotices,
    noticeTtlMs: config.noticeTtlMs,
    idleGraceMs: config.idleGraceMs,
  })
  const lifetime = new AbortController()
  const client = new PetClient({
    port: config.petPort,
    timeoutMs: config.petEventTimeoutMs,
    signal: lifetime.signal,
    log,
  })

  /** Pending `completed` deliveries, keyed by notice id. */
  const deliveries = new Map<string, ReturnType<typeof setTimeout>>()
  let control: ControlServer | null = null
  let browserRoutes: BrowserRoutes | null = null
  let disposed = false
  /** Observers handed in through `testHooks`; empty in production. */
  const boundObservers: Array<(result:
    | { readonly ok: true, readonly port: number, readonly token: string }
    | { readonly ok: false, readonly reason: string }) => void> = []

  /** Build the `/state` payload the pet reads. */
  const statePayload = (): StatePayload => ({
    v: PROTOCOL_VERSION,
    revision: store.snapshotRevision,
    sessions: store.progressSnapshot(),
    notices: store.allNotices(),
    petPort: client.isHandshaken ? client.port : null,
    browserRoutes: browserRoutes !== null,
    // The drift self-check (PL-EN-NW-06). Outside `revision` on purpose:
    // it is rewritten on every lease refresh, so counting it as a snapshot
    // change would make `revision` churn while nothing real had moved.
    browserTabs: browserRoutes?.diagnostics() ?? [],
    // The build-identity handshake (PL-EN-NW-02): what *this* host half was
    // compiled from, published next to each tab's report of the same fact in
    // `browserTabs`. Both are stated, neither is judged — a reader compares them
    // (`tools/probe-http.mjs` fails on a mismatch), because "the page is stale"
    // is a conclusion about two facts and this payload only carries one of them.
    buildId: BUILD_ID,
    pluginVersion: PLUGIN_VERSION,
  })

  /** Push a normalized event; suppressed until the pet has ever handshaken. */
  const push = (event: PetEvent): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (!client.isHandshaken) return Promise.resolve(false)
    return client.send(event).then(result => result.delivered)
  }

  /**
   * Push one settled run's result event.
   *
   * If the browser already confirmed the *exact* notice, the event carries
   * `seen: true` and the pet is expected not to pop anything. Otherwise it is a
   * normal popup, and a later observation becomes a separate `notice/seen` that
   * retires it.
   *
   * @param completion - the settled run.
   * @param noticeId - notice the pet keys its popup on.
   * @param eventName - `completed` or `error`, from {@link completionDispatch}.
   */
  const deliverCompletion = (
    completion: RunCompletion,
    noticeId: string,
    eventName: PetEventName,
  ): void => {
    // Read the notice's state rather than a side table: an observation that
    // landed during `notifyDelayMs` moved it to `seen` already.
    const seen = store.notice(noticeId)?.state === 'seen'
    const title = store.progressSnapshot().find(row => row.sessionId === completion.sessionId)?.title ?? null
    const event = buildEvent({
      id: randomUUID(),
      event: eventName,
      hook: 'run/idle',
      sessionId: completion.sessionId,
      runId: completion.runId,
      targetTurnRef: completion.targetTurnRef,
      at: completion.completedAt,
      title: config.includeTitle ? title : null,
      message: completionMessage(completion.reason),
      reason: completion.reason,
      seen,
      noticeId,
    })
    void push(event).then((delivered) => {
      if (!delivered) {
        // The pet was not listening. Leave the notice pending: the `/state`
        // snapshot is how it catches up after a restart.
        log(`completion ${noticeId} not delivered; kept pending`)
        return
      }
      store.markDelivered(noticeId, seen, Date.now())
    })
  }

  /** Turn a settled run into a (possibly notice-less) event plus its delivery. */
  const onCompletion = (completion: RunCompletion): void => {
    const dispatch = completionDispatch(completion.reason)
    if (!dispatch.notice) {
      // Not a completion: the run stopped (`aborted` / `interrupted`) or its
      // reason was unreadable. The pet is told the lifecycle changed and nothing
      // more — no notice means nothing can pop, and nothing has to be acked.
      const row = store.progressSnapshot().find(entry => entry.sessionId === completion.sessionId)
      log(`run ${completion.runId} settled as ${completion.reason}: reported as ${dispatch.event}, no notice`)
      void push(buildEvent({
        id: randomUUID(),
        event: dispatch.event,
        hook: 'run/idle',
        sessionId: completion.sessionId,
        runId: completion.runId,
        targetTurnRef: completion.targetTurnRef,
        at: completion.completedAt,
        title: config.includeTitle ? row?.title ?? null : null,
        message: completionMessage(completion.reason),
        reason: completion.reason,
      }))
      return
    }
    const noticeId = randomUUID()
    store.createNotice(completion, noticeId, completion.completedAt)
    const notice = store.notice(noticeId)
    if (notice === null) return
    // A run with no page-matchable turn reference can never be auto-observed,
    // so it goes out immediately and stays until the pet closes it.
    if (completion.targetTurnRef === null || config.notifyDelayMs <= 0) {
      deliverCompletion(completion, noticeId, dispatch.event)
      return
    }
    // Give the browser a short window to confirm the result is on screen before
    // the popup would otherwise be raised. This never blocks harness work.
    const timer = setTimeout(() => {
      deliveries.delete(noticeId)
      deliverCompletion(completion, noticeId, dispatch.event)
    }, config.notifyDelayMs)
    timer.unref?.()
    deliveries.set(noticeId, timer)
  }

  /** Apply the effects a store transition returned. */
  const applyEffects = (effects: { completions: readonly RunCompletion[] }): void => {
    for (const completion of effects.completions) onCompletion(completion)
  }

  /* ------------------------------------------------------------------ *
   * 1. Harness subscriptions
   * ------------------------------------------------------------------ */

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    const origin = session.header.origin
    const isSubagent = origin === 'subagent'
    const at = typeof event.time === 'number' && event.time > 0 ? event.time : Date.now()
    switch (event.type) {
      case 'turn/start': {
        if (isSubagent) return
        const runId = randomUUID()
        store.recordSessionFacts(sessionId, {
          subagent: false,
          ...(session.header.title === undefined ? {} : { title: session.header.title }),
          ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
        }, at)
        applyEffects(store.startRun(sessionId, runId, at))
        const row = store.progressSnapshot().find(entry => entry.sessionId === sessionId)
        void push(buildEvent({
          id: randomUUID(),
          event: 'running',
          hook: event.type,
          sessionId,
          runId: row?.runId ?? null,
          at,
          title: config.includeTitle ? row?.title ?? null : null,
        }))
        return
      }
      case 'tool/call': {
        if (isSubagent) return
        const data = event.data as { name?: unknown } | null
        const toolName = typeof data?.name === 'string' ? data.name : null
        store.recordProgress(sessionId, at, { tool: toolName })
        const row = store.progressSnapshot().find(entry => entry.sessionId === sessionId)
        void push(buildEvent({
          id: randomUUID(),
          event: 'running',
          hook: event.type,
          sessionId,
          runId: row?.runId ?? null,
          at,
          tool: toolName,
          title: config.includeTitle ? row?.title ?? null : null,
        }))
        return
      }
      case 'tool/result': {
        if (isSubagent) return
        const data = event.data as { error?: unknown } | null
        const failed = data?.error !== undefined
        if (!failed) return
        // A failed tool is not a failed run: the turn decides that.
        void push(buildEvent({
          id: randomUUID(),
          event: 'error',
          hook: event.type,
          sessionId,
          at,
          message: '工具调用失败',
        }))
        return
      }
      case 'todo/write': {
        if (isSubagent) return
        // Only counts cross the wire. Todo text routinely restates user input.
        const data = event.data as { todos?: unknown } | null
        const todos = Array.isArray(data?.todos) ? data.todos : []
        const completed = todos.filter((item) => {
          if (typeof item !== 'object' || item === null) return false
          return (item as { status?: unknown }).status === 'completed'
        }).length
        store.recordProgress(sessionId, at, {
          todoCount: todos.length,
          completedTodoCount: completed,
        })
        return
      }
      case 'turn/end': {
        if (isSubagent) return
        const data = event.data as { turn?: unknown, reason?: unknown } | null
        const turn = typeof data?.turn === 'number' ? data.turn : null
        const kind = turnEndKind(data?.reason)
        if (turn === null) {
          // Without a turn number there is no page-matchable reference, so the
          // notice must stay manual: record the reason, force no target.
          log(`turn/end without a turn number on ${sessionId}`)
          return
        }
        applyEffects(store.recordTurnEnd(sessionId, turn, kind, at))
        return
      }
      default:
        return
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = String(agent.session.id)
    const isSubagent = agent.session.header.origin === 'subagent'
    const at = Date.now()
    if (status === 'running') {
      if (isSubagent) return
      store.recordSessionFacts(sessionId, {
        subagent: false,
        ...(agent.session.header.title === undefined ? {} : { title: agent.session.header.title }),
        ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      }, at)
      applyEffects(store.startRun(sessionId, randomUUID(), at))
      return
    }
    if (isSubagent) return
    // A run reached idle. The store decides whether a recorded reason settles
    // it now or whether a late `turn/end` still gets a grace window.
    applyEffects(store.recordIdle(sessionId, at))
  })

  ctx.on('agent/error', ({ agent, error }) => {
    if (agent.session.header.origin === 'subagent') return
    const sessionId = String(agent.session.id)
    const at = Date.now()
    const row = store.progressSnapshot().find(entry => entry.sessionId === sessionId)
    // A failure during the run. It carries no `noticeId`: only a settled run's
    // result does, so the pet never pops a popup for this on its own.
    void push(buildEvent({
      id: randomUUID(),
      event: 'error',
      hook: 'agent/error',
      sessionId,
      runId: row?.runId ?? null,
      at,
      message: errorMessage(errorCategory(error)),
      title: config.includeTitle ? row?.title ?? null : null,
    }))
  })

  /* ------------------------------------------------------------------ *
   * 2. Timer: advance grace deadlines and expire old notices
   * ------------------------------------------------------------------ */

  const tick = setInterval(() => {
    applyEffects(store.consumeTime(Date.now()))
  }, 250)
  tick.unref?.()

  /* ------------------------------------------------------------------ *
   * 3. Control listener and the pet push loop
   * ------------------------------------------------------------------ */

  ctx.effect(() => {
    let closed = false
    /** Publish the bind outcome once, to whoever is observing. */
    const publishBound = (
      result:
        | { readonly ok: true, readonly port: number, readonly token: string }
        | { readonly ok: false, readonly reason: string },
    ): void => {
      for (const observer of boundObservers.splice(0)) observer(result)
    }
    void startControlServer({
      port: config.controlPort,
      ...(config.tokenFile === '' ? {} : { tokenFile: config.tokenFile }),
      statePayload,
      onHello: (port) => {
        const wasHandshaken = client.isHandshaken
        client.setPort(port)
        if (!wasHandshaken) log(`pet handshake accepted on port ${port}`)
      },
      onAck: (noticeId, action) => store.applyAck(noticeId, action),
      log,
    }).then((result) => {
      if (closed) {
        // The plugin unloaded while the listen was in flight; do not leak it.
        if (result.ok) void result.server.close()
        publishBound({ ok: false, reason: 'closed-before-bind' })
        return
      }
      if (!result.ok) {
        // A taken control port is fatal for the bridge only. Disable it loudly
        // rather than sending a token or events to whoever owns the port.
        warn(`control port ${config.controlPort} unavailable (${result.reason}); bridge disabled`)
        publishBound(result)
        return
      }
      control = result.server
      publishBound({ ok: true, port: result.server.port, token: result.server.token })
    })
    return () => {
      closed = true
      if (control !== null) {
        const server = control
        control = null
        void server.close()
      }
    }
  })

  ctx.effect(() => {
    // Probe the configured pet port once, in case the pet was already running
    // when the plugin mounted. A handshake later overrides this.
    void client.probe().then((delivered) => {
      if (delivered) log(`pet answered on the configured port ${client.port}`)
    })
    return () => {
      disposed = true
      clearInterval(tick)
      for (const timer of deliveries.values()) clearTimeout(timer)
      deliveries.clear()
      lifetime.abort()
    }
  })

  /* ------------------------------------------------------------------ *
   * 4. Browser routes — optional, because headless hosts have no WebServer
   * ------------------------------------------------------------------ */

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer') as Parameters<typeof mountBrowserRoutes>[0]['webServer'] | undefined
    if (webServer === undefined || typeof webServer.register !== 'function') return
    scoped.effect(() => {
      const mounted = mountBrowserRoutes({
        store,
        webServer,
        seenDwellMs: config.seenDwellMs,
        leaseTtlMs: DEFAULT_LEASE_TTL_MS,
        onObserved: (notice) => {
          // The pet already raised a popup for this notice, so it must be told
          // to cancel that exact one. Keyed by `noticeId`, which is why a
          // duplicate or reordered push cannot close an unrelated popup.
          void push(buildEvent({
            id: randomUUID(),
            event: 'notice/seen',
            hook: 'browser/observed',
            sessionId: notice.sessionId,
            runId: notice.runId,
            targetTurnRef: notice.targetTurnRef,
            at: notice.seenAt ?? Date.now(),
            noticeId: notice.noticeId,
          }))
        },
        log,
      })
      browserRoutes = mounted
      log(`browser routes mounted: ${mounted.paths.join(', ')}`)
      return () => {
        browserRoutes = null
        mounted.dispose()
      }
    })
  })

  /** Keeps the retained-notice table from outliving the plugin instance. */
  ctx.effect(() => () => {
    deliveries.clear()
  })

  log(`started (control :${config.controlPort}, pet :${config.petPort})`)
  testHooks?.onReady?.({
    disposed: () => disposed,
    onControlBound: (callback) => {
      if (control !== null) {
        callback({ ok: true, port: control.port, token: control.token })
        return
      }
      boundObservers.push(callback)
    },
  })
}

/** Re-exported for tests and for the pet-facing documentation. */
export { NoticeStore, buildEvent } from './state.js'
export { PetClient, buildProbeEvent, helloResponse, parseHello } from './pet-client.js'
export { startControlServer, tokenFilePath, writeTokenFile } from './control-server.js'
export type { ControlServer, ControlServerDeps } from './control-server.js'
export { DEFAULT_LEASE_TTL_MS, mountBrowserRoutes } from './routes.js'
export type { BrowserRoutes, WebServerFace } from './routes.js'
export type {
  BridgeCapability,
  HelloRequest,
  HelloResponse,
  NoticeSnapshot,
  NoticeState,
  PendingNotice,
  PetEvent,
  PetEventName,
  ProtocolRange,
  SessionProgressSnapshot,
  SessionReaderIndex,
  StatePayload,
  TabDiagnostic,
  TurnEndKind,
  TurnEndRecord,
} from './protocol.js'
export type { RunCompletion, SessionFacts } from './state.js'
export {
  BRIDGE_CAPABILITIES,
  BROWSER_ROUTES,
  BUILD_ID,
  CONTROL_ROUTES,
  DEFAULT_CONTROL_PORT,
  DEFAULT_PET_PORT,
  EVENT_SOURCE,
  MAX_REQUEST_BODY_BYTES,
  MAX_TITLE_LENGTH,
  NOTICE_EVENT_NAMES,
  PET_EVENT_NAMES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  RESERVED_PET_EVENT_NAMES,
  clampText,
  clampTitle,
  isLoopbackHost,
  isPort,
  isSameOriginLoopback,
} from './protocol.js'
