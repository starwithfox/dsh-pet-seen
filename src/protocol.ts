/**
 * Wire protocol shared by the three participants of the desktop-pet bridge:
 *
 *   host plugin (Node)  ←→  desktop pet (any local process)  ←→  browser page
 *
 * This module is the single source of truth for event names, payload shapes,
 * and the normalization table. The desktop-pet half (`pet.py`) reimplements the
 * receiving end against this same document instead of importing it, so every
 * change here is a protocol change and must bump {@link PROTOCOL_VERSION}.
 *
 * Deliberately dependency-free (no `node:` imports, no harness imports): the
 * browser bundle re-exports parts of this file, and the client build must not
 * pull Node builtins into the page.
 *
 * @module dsh-pet-bridge/protocol
 */

/** Protocol revision carried by every event, control response, and handshake. */
export const PROTOCOL_VERSION = 1

/** Event source tag the pet uses to tell this producer apart from its own UI. */
export const EVENT_SOURCE = 'deepseek-harness' as const

/** Default loopback port the pet listens on for `POST /event`. */
export const DEFAULT_PET_PORT = 17322

/** Default loopback port this plugin listens on for `/hello`, `/state`, `/ack`. */
export const DEFAULT_CONTROL_PORT = 17323

/** Hard cap on any request body this plugin accepts (bytes). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

/** Hard cap on the pet's response body the plugin is willing to read (bytes). */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024

/** Cap on a session title before it reaches the wire; titles echo user input. */
export const MAX_TITLE_LENGTH = 160

/** Cap on any human-readable one-liner before it reaches the wire. */
export const MAX_MESSAGE_LENGTH = 240

/**
 * Normalized event names. These are semantics, not raw harness event names:
 * several raw events collapse onto one normalized event (see
 * {@link normalizeSessionEvent}).
 */
export type PetEventName =
  | 'idle'
  | 'running'
  | 'completed'
  | 'error'
  | 'notice/seen'
  | 'session/removed'

/**
 * Turn-end reason kinds the notification state machine distinguishes. Mirrors
 * `TurnEndReasonMap` from `@deepseek-ai/dsh-session` without importing it.
 */
export type TurnEndKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'

/** A recorded `turn/end` outcome plus the turn reference the browser can match. */
export interface TurnEndRecord {
  /** `turn/end.data.turn` — the stable, page-matchable turn reference. */
  readonly turn: number
  /** Why that turn ended. */
  readonly kind: TurnEndKind
  /** Unix epoch ms the record was taken. */
  readonly at: number
}

/** One normalized event pushed to the pet's `/event` endpoint. */
export interface PetEvent {
  readonly v: typeof PROTOCOL_VERSION
  /** Unique event id; the pet dedupes on it. */
  readonly id: string
  readonly event: PetEventName
  readonly source: typeof EVENT_SOURCE
  /** Raw harness event or lifecycle hook that produced this event. */
  readonly hook: string
  readonly sessionId: string
  /** One run of one root session. A new run never reuses the previous runId. */
  readonly runId: string | null
  /** `turn/end.data.turn`, or null when no reliable reference exists. */
  readonly targetTurnRef: string | null
  readonly timestamp: number
  title?: string | null
  message?: string
  tool?: string
  /** Present on result events: the recorded turn-end kind. */
  reason?: TurnEndKind
  /** Present on result events: `true` when the browser already observed it. */
  seen?: boolean
  /** Present on every notice-bearing event; the pet keys its popup on it. */
  noticeId?: string
}

/** Lifecycle state of one notice, owned by the host. */
export type NoticeState = 'pending' | 'shown' | 'seen' | 'dismissed'

/** One run-completion notice awaiting delivery or acknowledgement. */
export interface NoticeSnapshot {
  readonly noticeId: string
  readonly sessionId: string
  readonly runId: string
  readonly targetTurnRef: string | null
  readonly reason: TurnEndKind
  readonly completedAt: number
  readonly state: NoticeState
  readonly seenAt: number | null
  /** True once a `completed` event carrying this notice was handed to the pet. */
  readonly delivered: boolean
}

/** Per-session progress bucket. One entry per root session, never a global state. */
export interface SessionProgressSnapshot {
  readonly sessionId: string
  readonly title: string | null
  readonly cwd: string | null
  readonly origin: 'subagent' | null
  readonly running: boolean
  readonly runId: string | null
  readonly lastTurnEnd: TurnEndRecord | null
  /** Count of `tool/call` events in the current run; never the raw arguments. */
  readonly toolCalls: number
  readonly lastTool: string | null
  /** Count of `todo/write` items in the current run; never their content. */
  readonly todoCount: number
  readonly completedTodoCount: number
  readonly percent: number | null
  readonly updatedAt: number
}

/** `GET /state` response body. */
export interface StatePayload {
  readonly v: typeof PROTOCOL_VERSION
  /** Snapshot revision, monotonically increasing per host process. */
  readonly revision: number
  readonly sessions: readonly SessionProgressSnapshot[]
  readonly notices: readonly NoticeSnapshot[]
  /** Actual pet port in force, or null before the first successful handshake. */
  readonly petPort: number | null
  /** Whether the browser route half is mounted (the DSH WebServer is present). */
  readonly browserRoutes: boolean
}

/** `POST /hello` request body from the pet. */
export interface HelloRequest {
  readonly v: typeof PROTOCOL_VERSION
  readonly petVersion?: string
  /** The port the pet is actually listening on for `/event`. */
  readonly port: number
  /** Shared secret; written by the host to `~/.dsh/pet-bridge.json`. */
  readonly token?: string
}

/** `POST /hello` response body. */
export interface HelloResponse {
  readonly v: typeof PROTOCOL_VERSION
  readonly ok: true
  readonly revision: number
  /** Port the pet should keep listening on; echoed for a cheap sanity check. */
  readonly petPort: number
}

/** `POST /ack` request body from the pet. */
export interface AckRequest {
  readonly v: typeof PROTOCOL_VERSION
  readonly noticeId: string
  readonly action: 'shown' | 'dismissed'
  readonly token?: string
}

/** `POST /ack` response body. */
export interface AckResponse {
  readonly v: typeof PROTOCOL_VERSION
  readonly ok: boolean
  readonly state?: NoticeState
}

/** `POST /pet-bridge/visibility` request body from the browser page. */
export interface VisibilityRequest {
  readonly v: typeof PROTOCOL_VERSION
  /** Opaque per-tab-instance id; the host keeps a short focus lease per tab. */
  readonly tabId: string
  readonly sessionId: string | null
  /** L1: `document.visibilityState === 'visible'`. */
  readonly visible: boolean
  /** L2: `document.hasFocus()`. */
  readonly focused: boolean
  /** Optional session title from the client snapshot (host stores it verbatim). */
  readonly title?: string | null
}

/** One pending notice the browser is asked to watch for. */
export interface PendingNotice {
  readonly noticeId: string
  readonly sessionId: string
  readonly runId: string
  readonly targetTurnRef: string | null
  readonly reason: TurnEndKind
  readonly completedAt: number
}

/** `GET /pet-bridge/notices?sessionId=...` response body. */
export interface NoticesPayload {
  readonly v: typeof PROTOCOL_VERSION
  readonly revision: number
  readonly sessionId: string
  readonly notices: readonly PendingNotice[]
  /** Milliseconds of continuous visibility required before `/seen` is accepted. */
  readonly seenDwellMs: number
}

/** `POST /pet-bridge/seen` request body from the browser page. */
export interface SeenRequest {
  readonly v: typeof PROTOCOL_VERSION
  readonly noticeId: string
  readonly runId: string
  readonly sessionId: string
  readonly tabId: string
  /** Must be exactly `true`; a mere report of visibility is not an observation. */
  readonly observed: true
}

/** `POST /pet-bridge/seen` response body. */
export interface SeenResponse {
  readonly v: typeof PROTOCOL_VERSION
  /** True when the host accepted the observation and marked the notice seen. */
  readonly accepted: boolean
  /** Machine-readable reason when `accepted` is false. */
  readonly reason?: string
}

/**
 * Browser-facing route paths. Each is registered as its own `exact` route so a
 * method mismatch is answered per path instead of falling through to a shared
 * dispatcher.
 */
export const BROWSER_ROUTES = {
  visibility: '/pet-bridge/visibility',
  notices: '/pet-bridge/notices',
  seen: '/pet-bridge/seen',
} as const

/** Control-endpoint paths served on the loopback control port. */
export const CONTROL_ROUTES = {
  hello: '/hello',
  state: '/state',
  ack: '/ack',
} as const

/** Hostnames accepted by the browser-side same-origin check. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Same-origin check for browser calls, mirroring the approach used by the
 * installed `dsh-plugin` package: the `Origin` host must equal the request
 * `Host` and must itself be a loopback name.
 *
 * A missing `Origin` is accepted only when `Host` is loopback, because
 * same-origin `fetch` from the DSH page always sends one and non-browser
 * clients on loopback are already handled by the bearer token path.
 *
 * @param origin - raw `Origin` header, if any.
 * @param host - raw `Host` header, if any.
 * @returns true when the request is an accepted same-origin loopback call.
 */
export function isSameOriginLoopback(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (host === undefined || host === '') return false
  const hostName = stripPort(host)
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false
  if (origin === undefined || origin === '') return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // The Origin's host must itself be loopback: that is what rules out a
  // cross-site page, whose `Host` header the browser still sets to the server
  // it dialled rather than to the page's own origin.
  const originHost = stripPort(parsed.host)
  if (!isLoopbackName(originHost)) return false
  // A different listener on this machine is not this server. The port is
  // compared explicitly because `stripPort` deliberately drops it in order to
  // treat `localhost` and `127.0.0.1` spelling differences as one host.
  return portOf(parsed.host) === portOf(host)
}

/**
 * Port of a `host[:port]` value, or `-1` when absent.
 *
 * @param host - a `Host`-header-shaped value.
 * @returns the numeric port, or -1 for a missing/unparsable one.
 */
function portOf(host: string): number {
  const bare = host.startsWith('[') ? host.slice(host.indexOf(']') + 1) : host
  const colon = bare.lastIndexOf(':')
  if (colon === -1) return -1
  const port = Number(bare.slice(colon + 1))
  return Number.isSafeInteger(port) && port > 0 ? port : -1
}

/** Whether a host name (without port) is one of the accepted loopback names. */
function isLoopbackName(hostName: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostName)
}

/**
 * Whether a raw `Host` header names a loopback address. Used to reject the
 * pet's control calls when the listener is accidentally reachable off-host.
 *
 * @param host - raw `Host` header, if any.
 * @returns true when the host name is loopback.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return false
  return LOOPBACK_HOSTNAMES.has(stripPort(host))
}

/** Strip a `:port` suffix, leaving IPv6 brackets intact. */
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const closing = host.indexOf(']')
    return closing === -1 ? host : host.slice(0, closing + 1)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

/**
 * Truncate a string that may echo user input.
 *
 * Truncation is a display bound, not a privacy boundary: callers must not treat
 * a truncated field as safe when the protocol never promised to carry it at all
 * (see the field whitelist in the host implementation).
 *
 * @param value - raw text, or undefined.
 * @param limit - maximum length; longer values get an ellipsis.
 * @returns the bounded text, or undefined when the input was empty.
 */
export function clampText(value: string | undefined | null, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 3)}...`
}

/** Type guard for a value usable as a loopback TCP port. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535
}

/** A parsed JSON object body, before it is narrowed to a specific request shape. */
export type JsonObject = Record<string, unknown>

/**
 * Clamp a session title, which routinely embeds a slice of the user's prompt.
 *
 * @param value - raw title, or undefined/null.
 * @returns the bounded title, or undefined when there was nothing to send.
 */
export function clampTitle(value: string | undefined | null): string | undefined {
  return clampText(value, MAX_TITLE_LENGTH)
}
