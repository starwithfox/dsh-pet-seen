/**
 * Host half of `dsh-pet-bridge`.
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
 * @module dsh-pet-bridge
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_PET_PORT,
  PROTOCOL_VERSION,
  clampTitle,
} from './protocol.js'
import type { NoticeSnapshot, PetEvent, StatePayload, TurnEndKind } from './protocol.js'
import { NoticeStore, buildEvent } from './state.js'
import type { RunCompletion } from './state.js'
import { PetClient } from './pet-client.js'
import { startControlServer } from './control-server.js'
import type { ControlServer } from './control-server.js'
import { DEFAULT_LEASE_TTL_MS, mountBrowserRoutes } from './routes.js'
import type { BrowserRoutes } from './routes.js'

/** Plugin name as the loader knows it. */
export const name = 'dsh-pet-bridge'

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

/*
 * Minimal structural faces for the harness values this plugin touches.
 *
 * Declaring them here rather than importing the harness classes keeps the host
 * bundle free of harness imports, and keeps the plugin compiling against a
 * harness whose internal type names moved. The two `@ts-expect-error`-free
 * assertions below pin each face to the real declaration, so a shape drift
 * fails the type check instead of failing at 3am in a user's session.
 */

/** The slice of `Session` this plugin reads. */
export interface SessionFace {
  readonly id: unknown
  readonly header: {
    readonly cwd?: string
    /** Present exactly for subagent sessions. */
    readonly origin?: 'subagent'
    /** Session title, when the store keeps one on the header. */
    readonly title?: string
  }
}

/** The slice of one `session/event` entry this plugin reads. */
export interface SessionEventFace {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** The slice of `Agent` this plugin reads. */
export interface AgentFace {
  readonly session: SessionFace
  readonly status: 'idle' | 'running'
}

/** The `session/event` listener signature. */
type SessionEventListener = (session: SessionFace, event: SessionEventFace) => void

/** The `agent/status` listener signature. */
type AgentStatusListener = (payload: { agent: AgentFace, status: 'idle' | 'running' }) => void

/** The `agent/error` listener signature. */
type AgentErrorListener = (payload: { agent: AgentFace, error: unknown }) => void

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

/*
 * Compile-time pins. Each statement fails to compile if the real harness type
 * stops being assignable to the face this plugin codes against.
 */
type _SessionPinned = import('@deepseek-ai/dsh-session').Session extends SessionFace ? true : never
type _AgentPinned = import('@deepseek-ai/dsh-agent').Agent extends AgentFace ? true : never
export type PinnedHarnessShapes = [_SessionPinned, _AgentPinned]

/** Narrow `TurnEndReason` to the kinds the protocol names. */
function turnEndKind(reason: unknown): TurnEndKind {
  if (typeof reason !== 'object' || reason === null) return 'completed'
  const kind = (reason as { kind?: unknown }).kind
  switch (kind) {
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'error':
    case 'max-tokens':
    case 'interrupted':
      return kind
    default:
      // The reason map is merge-extensible, so an unknown kind must degrade to
      // something safe. `completed` is the only kind that reports success, and
      // it is also what a plain turn end means when no reason was recorded.
      return 'completed'
  }
}

/** Bounded, content-free description of a failure. */
function errorSummary(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, 200)
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code.slice(0, 64)
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message.slice(0, 200)
  }
  return 'error'
}

/** Human-readable one-liner for a completion, by turn-end kind. */
function completionMessage(kind: TurnEndKind): string {
  switch (kind) {
    case 'completed': return '任务完成'
    case 'max-tokens': return '达到输出上限后结束'
    case 'blocked': return '被阻塞，需要处理'
    case 'error': return '运行出错'
    case 'aborted': return '已中止'
    case 'interrupted': return '中断（会话恢复时补记）'
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
    ctx.logger?.info?.(`dsh-pet-bridge: ${message}`)
  }
  const warn = (message: string): void => {
    ctx.logger?.warn?.(`dsh-pet-bridge: ${message}`)
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
  })

  /** Push a normalized event; suppressed until the pet has ever handshaken. */
  const push = (event: PetEvent): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (!client.isHandshaken) return Promise.resolve(false)
    return client.send(event).then(result => result.delivered)
  }

  /**
   * Push `completed` for one settled run.
   *
   * If the browser already confirmed the *exact* notice, the event carries
   * `seen: true` and the pet is expected not to pop anything. Otherwise it is a
   * normal popup, and a later observation becomes a separate `notice/seen` that
   * retires it.
   */
  const deliverCompletion = (completion: RunCompletion, noticeId: string): void => {
    // Read the notice's state rather than a side table: an observation that
    // landed during `notifyDelayMs` moved it to `seen` already.
    const seen = store.notice(noticeId)?.state === 'seen'
    const title = store.progressSnapshot().find(row => row.sessionId === completion.sessionId)?.title ?? null
    const event = buildEvent({
      id: randomUUID(),
      event: 'completed',
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

  /** Turn a settled run into a notice plus its (delayed) delivery. */
  const onCompletion = (completion: RunCompletion): void => {
    const noticeId = randomUUID()
    store.createNotice(completion, noticeId, completion.completedAt)
    const notice = store.notice(noticeId)
    if (notice === null) return
    // A run with no page-matchable turn reference can never be auto-observed,
    // so it goes out immediately and stays until the pet closes it.
    if (completion.targetTurnRef === null || config.notifyDelayMs <= 0) {
      deliverCompletion(completion, noticeId)
      return
    }
    // Give the browser a short window to confirm the result is on screen before
    // the popup would otherwise be raised. This never blocks harness work.
    const timer = setTimeout(() => {
      deliveries.delete(noticeId)
      deliverCompletion(completion, noticeId)
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
    void push(buildEvent({
      id: randomUUID(),
      event: 'error',
      hook: 'agent/error',
      sessionId,
      runId: row?.runId ?? null,
      at,
      message: `运行出错：${errorSummary(error)}`,
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
  NoticeSnapshot,
  NoticeState,
  PendingNotice,
  PetEvent,
  PetEventName,
  SessionProgressSnapshot,
  StatePayload,
  TurnEndKind,
  TurnEndRecord,
} from './protocol.js'
export type { RunCompletion, SessionFacts } from './state.js'
export {
  BROWSER_ROUTES,
  CONTROL_ROUTES,
  DEFAULT_CONTROL_PORT,
  DEFAULT_PET_PORT,
  EVENT_SOURCE,
  MAX_REQUEST_BODY_BYTES,
  MAX_TITLE_LENGTH,
  PROTOCOL_VERSION,
  clampText,
  clampTitle,
  isLoopbackHost,
  isPort,
  isSameOriginLoopback,
} from './protocol.js'
