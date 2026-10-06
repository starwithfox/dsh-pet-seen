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
 * **What counts as a version bump.** Everything the pet parses — events,
 * `/hello`, `/ack`, `/state` — is a wire contract with a second implementation
 * in `pet.py`, so a change there has to bump {@link PROTOCOL_VERSION}. An
 * additive *optional* field on a browser-only route is not that: the pet never
 * reads `/pet-bridge/visibility`, and no participant can observe the addition
 * except the host. Those stay on v1 (see {@link VisibilityRequest.reader} and
 * {@link VisibilityRequest.buildId}). The same holds for a **new** field on
 * `/state`: `pet_bridge.snapshot_status()` reads `sessions` and `revision` and
 * ignores every other key, so {@link StatePayload.buildId} is additive too.
 *
 * @module dsh-pet-seen/protocol
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
 * Cap on the reported `sessions.list.byId` size.
 *
 * A diagnostic bound, not a correctness one: the number is only ever printed, so
 * it is clamped to keep an absurd value out of the snapshot instead of out of
 * the page.
 */
export const MAX_BY_ID_COUNT = 10_000

/*
 * Build identity, baked into **both** bundles by the bundler
 * (`tsdown.config.ts` defines these two from `tools/build-id.mjs`). They are
 * ambient here rather than imported because the value has to be a literal in the
 * artifact: the whole point is that each half can state which build it came
 * from without asking anyone.
 *
 * The `typeof` guards are what keeps the same source runnable outside a bundle.
 * The test suite compiles `src/` with plain `tsc` (`test-dist/`), where no
 * bundler ever substitutes these — `typeof` on an undeclared identifier is
 * legal and yields `'undefined'`, so tests see the explicit fallbacks below
 * instead of a `ReferenceError` at import time.
 */
declare const __PET_BUILD_ID__: string
declare const __PET_PLUGIN_VERSION__: string

/**
 * Identity of the build these bytes came from.
 *
 * Derived from the package version and the contents of every file under `src/`,
 * so two halves that were not built together cannot share it. The host publishes
 * its own copy in `GET /state`, each page reports its own on
 * `POST /pet-bridge/visibility`, and `tools/probe-http.mjs` fails when either is
 * missing or when the two disagree — which is how a half-refreshed install
 * ("host new, page old", or the reverse) stops being silent. See the build
 * handshake (PL-EN-NW-02).
 */
export const BUILD_ID: string =
  typeof __PET_BUILD_ID__ === 'string' && __PET_BUILD_ID__ !== '' ? __PET_BUILD_ID__ : 'unbundled'

/**
 * `package.json` `version` at the moment this build was made.
 *
 * The human-readable half of the same fact: {@link BUILD_ID} answers "same
 * build or not", this answers "which release is it" without a hash lookup. It is
 * the *plugin's* version — deliberately not the DSH version the peer range in
 * `package.json` talks about, and not {@link PROTOCOL_VERSION}.
 */
export const PLUGIN_VERSION: string =
  typeof __PET_PLUGIN_VERSION__ === 'string' && __PET_PLUGIN_VERSION__ !== ''
    ? __PET_PLUGIN_VERSION__
    : '0.0.0-unbundled'

/**
 * Cap on a build identity that arrives from a page.
 *
 * The client sends 16 hex characters or the `unbundled` fallback; the bound
 * exists so a buggy or hostile page cannot write an unbounded string into the
 * snapshot. Same rule as {@link MAX_BY_ID_COUNT}: a diagnostic value is bounded
 * at the door rather than trusted.
 */
export const MAX_BUILD_ID_LENGTH = 64

/**
 * Normalized event names. These are semantics, not raw harness event names:
 * several raw events collapse onto one normalized event. The mapping itself
 * lives host-side — `completionDispatch` in `src/index.ts` for settled runs,
 * and the `session/event` handler for the `running` / `error` chatter.
 */
export type PetEventName =
  | 'idle'
  | 'running'
  | 'completed'
  | 'error'
  | 'notice/seen'

/**
 * The normalized events this host actually dispatches, as a runtime list.
 *
 * `session/removed` used to sit beside these as a **reserved** name: the type
 * and the pet's own `EVENT_NAMES` accepted it, but nothing subscribed to
 * `session/disposed`, so the host could never send it (IS-014). `PL-PR-IV-01`
 * ran the runtime probe and settled it the other way — in real use the only
 * thing that disposes a session is the teardown of the fiber that created it,
 * and every root session is created by a process-lifetime fiber. The only
 * session that ever got disposed was a finished subagent's, which the pet does
 * not even display. So the name is gone rather than reserved: publishing a
 * capability nobody can trigger is what IS-014 was about.
 *
 * Runtime arrays rather than types alone because `protocol/bridge-v1.schema.json`
 * enumerates them and the drift test compares them by value (PL-PR-NW-02).
 */
export const PET_EVENT_NAMES: readonly PetEventName[] = [
  'idle',
  'running',
  'completed',
  'error',
  'notice/seen',
]

/**
 * Turn-end reason kinds the notification state machine distinguishes. Mirrors
 * `TurnEndReasonMap` from `@deepseek-ai/dsh-session` without importing it.
 *
 * `'forked'` (added by DSH 0.2.0) is the synthesized ending of an **unclosed
 * turn in a forked session's inherited prefix**: nothing finished, the parent
 * is still running and the child has not started, so it maps to `idle` and
 * mints no notice — exactly like `aborted` / `interrupted`, and deliberately
 * *not* like `completed`. The `_ReasonsCovered` pin in `src/pins.ts` is what
 * forced this kind to be named instead of silently degrading to `'unknown'`.
 *
 * `'unknown'` is deliberately *not* one of the harness kinds: it is what a
 * missing, malformed or not-yet-named reason degrades to, and it must never be
 * treated as a successful completion.
 */
export type TurnEndKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'forked'
  | 'max-tokens'
  | 'interrupted'
  | 'unknown'

/**
 * The event names that may carry a settled run's `noticeId`.
 *
 * These are the two *result* events. `error` appears in both roles — a
 * notice-bearing result and a running-time failure report — so the pet's rule is
 * "pop up only when `noticeId` is present", never "when the name is `error`".
 * Everything else (`idle`, `running`) is lifecycle chatter.
 */
export const NOTICE_EVENT_NAMES: readonly PetEventName[] = ['completed', 'error']

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

/**
 * Which of the client's four session reads answered.
 *
 * The chain itself lives in `src/client/decide.ts`; the index travels to the
 * host as a **drift signal** (the self-check, PL-EN-NW-06). `-1` means
 * no read answered at all, which is the state the whole self-check exists for:
 * on 0.2.0-rc.2 the same condition silently produced no notice retraction and
 * left no trace anywhere.
 */
export type SessionReaderIndex = 0 | 1 | 2 | 3 | -1

/**
 * Type guard for a value usable as a {@link SessionReaderIndex}.
 *
 * Deliberately strict, because the value arrives from a page: `"0"`, `1.5`, `-2`
 * and `4` are all dropped rather than coerced, so a malformed report degrades to
 * "no diagnostic" instead of inventing one.
 *
 * @param value - candidate value from a request body.
 * @returns true when the value is one of the five valid indices.
 */
export function isReaderIndex(value: unknown): value is SessionReaderIndex {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= -1
    && value <= 3
}

/**
 * What one browser tab last reported about its own session read.
 *
 * This lives outside {@link SessionProgressSnapshot} on purpose: the most
 * important reading is `reader === -1`, i.e. "no session was found", and a
 * per-session row cannot carry a diagnostic for a session that was never named.
 * Rows are bounded by the lease table they are derived from, so they disappear
 * with the tab's focus lease instead of accumulating.
 */
export interface TabDiagnostic {
  /** Opaque per-tab-instance id, the same one the page keys its lease with. */
  readonly tabId: string
  /** The session that tab named, or null when it named none. */
  readonly sessionId: string | null
  /** Last reported hit index, or null when the tab never sent one. */
  readonly reader: SessionReaderIndex | null
  /** Last reported read name, or null. */
  readonly readerReason: string | null
  /** Last reported `byId` size, or null. */
  readonly byIdCount: number | null
  /**
   * Build identity that tab's client half reported, or null.
   *
   * Added with the build handshake (PL-EN-NW-02). `null` means "this tab never reported one", which is what
   * an older client half looks like — the same distinction
   * {@link TabDiagnostic.reader} draws for the drift self-check, and the reason
   * the two are separate concerns: a client half that has the drift self-check
   * (PL-EN-NW-06) but predates the build handshake reports a `reader` and no
   * `buildId`, and one older than both reports neither.
   */
  readonly buildId: string | null
  /** Epoch ms of that tab's last visibility report. */
  readonly at: number
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
  /**
   * Which page read answered for this session, as last reported.
   *
   * Absent until a page has reported one, and only ever set for a session that
   * was actually named — the `-1` reading has no session to attach to and is
   * carried by {@link StatePayload.browserTabs} instead.
   */
  readonly reader?: SessionReaderIndex
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
  /**
   * Identity of the build this host half was compiled from (PL-EN-NW-02).
   *
   * The other end of the handshake: each page reports its own
   * {@link TabDiagnostic.buildId} on every visibility report, and this is what
   * the host itself claims to be. Equal values mean the two halves came from one
   * build; a reader (`tools/probe-http.mjs`, `tools/bridge-state.mjs`) is what
   * turns a difference into a report, because the host deliberately publishes
   * the two facts rather than a verdict about them.
   */
  readonly buildId: string
  /**
   * `package.json` `version` this build was made from, for humans.
   *
   * Distinct from {@link StatePayload.v} (the protocol revision) and from the
   * DSH version the peer range talks about; see {@link PLUGIN_VERSION}.
   */
  readonly pluginVersion: string
  /**
   * Per-tab session-read diagnostics, most recent report first.
   *
   * Empty when no page has reported, including every headless host. This is the
   * only place a `reader === -1` reading can appear: the per-session field needs
   * a session, and "none of the four reads answered" is exactly the case where
   * there is none — which is why the field is separate rather than optional on
   * {@link SessionProgressSnapshot}.
   *
   * Deliberately **not** revision-tracked: it is rewritten on every lease
   * refresh (about every five seconds per visible tab) and would otherwise make
   * `revision` churn while no session, run or notice had changed at all.
   */
  readonly browserTabs: readonly TabDiagnostic[]
}

/**
 * Capability names a pet and this host negotiate at `/hello` (PL-PR-NW-02).
 *
 * One vocabulary for both directions: the pet declares which of these it
 * implements, and the host answers with the set it supports plus the
 * intersection it will actually rely on. A capability does not gate the event
 * stream — a missing one only removes an *assumption*:
 *
 * - `events` — accepts `POST /event` at all.
 * - `state-sync` — pulls `GET /state` and aligns its popups to that snapshot.
 * - `ack-shown` — reports a popup that is really on screen through `/ack`.
 * - `ack-dismissed` — reports a popup the user closed by hand.
 * - `notice-seen` — treats `notice/seen` as "retire that popup".
 *
 * A pet that declares no set at all is a **legacy** pet: the handshake and every
 * push keep working exactly as before, and the only thing the host may not do is
 * read the absent `ack-shown` as "that popup was never displayed".
 *
 * The drift test compares this list, `protocol/bridge-v1.schema.json`, and the
 * second receiver in `tools/mock-pet.mjs` by value.
 */
export const BRIDGE_CAPABILITIES = [
  'events',
  'state-sync',
  'ack-shown',
  'ack-dismissed',
  'notice-seen',
] as const

/** One negotiated capability name. */
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number]

/**
 * Protocol revisions a pet says it can speak, inclusive on both ends.
 *
 * Additive on v1: a pet that omits it is simply not asked to agree on a range,
 * and the handshake still succeeds — the host answers on
 * {@link PROTOCOL_VERSION} and the pet's `v` check remains the real gate.
 */
export interface ProtocolRange {
  readonly min: number
  readonly max: number
}

/** `POST /hello` request body from the pet. */
export interface HelloRequest {
  readonly v: typeof PROTOCOL_VERSION
  readonly petVersion?: string
  /** The port the pet is actually listening on for `/event`. */
  readonly port: number
  /** Shared secret; written by the host to `~/.dsh/pet-bridge.json`. */
  readonly token?: string
  /** Revisions the pet can speak; omitted by a pet that never negotiated one. */
  readonly protocol?: ProtocolRange
  /**
   * What the pet implements, out of {@link BRIDGE_CAPABILITIES}.
   *
   * Deliberately the *absence* of the field, not an empty array, that means
   * "legacy": `[]` is a modern pet that declares it implements none of them, and
   * the two are different facts about the sender.
   */
  readonly capabilities?: readonly BridgeCapability[]
}

/** `POST /hello` response body. */
export interface HelloResponse {
  readonly v: typeof PROTOCOL_VERSION
  readonly ok: true
  readonly revision: number
  /** Port the pet should keep listening on; echoed for a cheap sanity check. */
  readonly petPort: number
  /** What this host supports, so the pet can fall back deliberately. */
  readonly capabilities: readonly BridgeCapability[]
  /**
   * The intersection the host will rely on: its own set filtered by what the pet
   * declared. Empty for a legacy pet — which also means the host assumes no
   * acknowledgement behaviour at all.
   */
  readonly agreed: readonly BridgeCapability[]
  /** Present only when the request carried no `capabilities` field. */
  readonly legacy?: true
  /**
   * Echo of {@link HelloRequest.petVersion}, present when the pet sent one.
   *
   * Declared here because the control listener has always put it on the wire:
   * the type used to stop short of the bytes, which is exactly the kind of gap
   * the published schema is meant to make impossible (PL-PR-NW-02).
   */
  readonly petVersion?: string
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
  /** Machine-readable failure reason, on the same footing as `/hello`'s. */
  readonly reason?: string
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
  /**
   * Which of the client's four reads answered (the drift signal, PL-EN-NW-06).
   *
   * Sent on **every** report, including the ones where no session was found:
   * `-1` is the reading worth keeping. Diagnostics only — nothing here can mark
   * a notice seen, and the pet never reads this route, which is why the fields
   * are additive on v1 rather than a protocol bump.
   */
  readonly reader?: SessionReaderIndex
  /** Human-readable name of that read; a bounded one-liner, not parsed. */
  readonly readerReason?: string
  /** Size of `sessions.list.byId` when the report was made. */
  readonly byIdCount?: number
  /**
   * Identity of the build this page's client half came from (PL-EN-NW-02).
   *
   * Sent on every report, including the `pagehide` withdrawal, so the host can
   * hold it next to its own {@link BUILD_ID} and a half-refreshed install
   * becomes visible in `GET /state` instead of staying silent. Additive on v1:
   * this is a browser-only route the pet never reads.
   */
  readonly buildId?: string
}

/** One notice the browser is asked to watch for. */
export interface PendingNotice {
  readonly noticeId: string
  readonly sessionId: string
  readonly runId: string
  readonly targetTurnRef: string | null
  readonly reason: TurnEndKind
  readonly completedAt: number
  /**
   * `pending` or `shown`.
   *
   * Carried so the page (and a human reading `/pet-bridge/notices` directly)
   * can tell "never delivered" from "already on the pet's screen" — the two
   * cases that used to be one, and the reason a displayed notice could not be
   * observed at all.
   */
  readonly state: NoticeState
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
