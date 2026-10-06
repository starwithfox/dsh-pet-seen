/**
 * Outbound half of the pet link: pushes normalized events to the pet's
 * loopback `/event` endpoint.
 *
 * The design rules this implements:
 *
 * - **The pet never blocks the harness.** A send is bounded by a timeout and
 *   every failure resolves to `false`. Progress events are allowed to be lost,
 *   because the `/state` snapshot repairs them; result notifications are not,
 *   which is why the caller keeps them in its own pending table and only marks
 *   them delivered on a `true` result.
 * - **Order matters per notice.** Sends are serialized through one promise
 *   chain, so a `completed` can never overtake the `notice/seen` that retires
 *   it, or the reverse.
 * - **Nothing is buffered while the pet is away.** The queue holds at most the
 *   in-flight request; a backlog of stale "running" frames is worse than none.
 *
 * @module dsh-pet-seen/pet-client
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BRIDGE_CAPABILITIES, EVENT_SOURCE, PROTOCOL_VERSION, MAX_RESPONSE_BODY_BYTES } from './protocol.js'
import type { BridgeCapability, HelloRequest, HelloResponse, PetEvent, ProtocolRange } from './protocol.js'

/** Construction options for {@link PetClient}. */
export interface PetClientOptions {
  /** Port the pet listens on. Updated by {@link PetClient.setPort} after `/hello`. */
  readonly port: number
  /** Per-request timeout in ms. */
  readonly timeoutMs: number
  /** Lifecycle signal; aborting it fails in-flight and future sends. */
  readonly signal: AbortSignal
  /** Optional diagnostic sink. Never receives payload contents. */
  readonly log?: (message: string) => void
}

/** Result of one POST to the pet. */
export interface SendResult {
  readonly delivered: boolean
  /** Parsed response body, when the pet returned JSON. */
  readonly body: Record<string, unknown> | null
  /** Machine-readable failure reason; absent on success. */
  readonly failure?: string
}

/** Promise-based loopback JSON POST; never throws, always resolves. */
function postJson(options: {
  port: number
  path: string
  body: unknown
  timeoutMs: number
  signal: AbortSignal
}): Promise<SendResult> {
  const { port, path, body, timeoutMs, signal } = options
  if (signal.aborted) return Promise.resolve({ delivered: false, body: null, failure: 'aborted' })
  const encoded = JSON.stringify(body)
  return new Promise<SendResult>((resolve) => {
    let settled = false
    const finish = (result: SendResult): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      request.destroy()
      finish({ delivered: false, body: null, failure: 'aborted' })
    }
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(encoded),
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (text.length < MAX_RESPONSE_BODY_BYTES) text += chunk
        else request.destroy()
      })
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          finish({ delivered: false, body: null, failure: `http-${status}` })
          return
        }
        if (text === '') {
          finish({ delivered: true, body: null })
          return
        }
        try {
          const parsed: unknown = JSON.parse(text)
          const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
          finish({ delivered: true, body: record })
        } catch {
          finish({ delivered: true, body: null, failure: 'unparsable-response' })
        }
      })
    })
    request.on('timeout', () => {
      request.destroy()
      finish({ delivered: false, body: null, failure: 'timeout' })
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({ delivered: false, body: null, failure: error.code ?? 'network-error' })
    })
    signal.addEventListener('abort', onAbort, { once: true })
    request.write(encoded)
    request.end()
  })
}

/**
 * Serialized, bounded, fire-and-forget client for the pet's event endpoint.
 *
 * Sends are never awaited by the harness's own work: `send` returns a promise,
 * but callers do not need to hold it, and failures only surface through the
 * returned {@link SendResult}.
 */
export class PetClient {
  /** Current target port; starts at the default and follows `/hello`. */
  private petPort: number
  private readonly timeoutMs: number
  private readonly signal: AbortSignal
  private readonly log: (message: string) => void
  /** Tail of the serialization chain; never rejects. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Whether the pet has completed a handshake at least once this session. */
  private handshaken = false

  constructor(options: PetClientOptions) {
    this.petPort = options.port
    this.timeoutMs = options.timeoutMs
    this.signal = options.signal
    this.log = options.log ?? (() => {})
  }

  /** Port events are currently pushed to. */
  get port(): number {
    return this.petPort
  }

  /** Whether a handshake has been seen; events are suppressed until then. */
  get isHandshaken(): boolean {
    return this.handshaken
  }

  /**
   * Adopt the port reported by the pet's `/hello`.
   *
   * @param port - the pet's listening port.
   */
  setPort(port: number): void {
    this.handshaken = true
    if (port === this.petPort) return
    this.log(`pet port ${this.petPort} -> ${port}`)
    this.petPort = port
  }

  /**
   * Test whether a pet is already listening on {@link PetClient.port}, for the
   * case where the pet started before this plugin mounted. A `false` result
   * leaves the bridge waiting for a `/hello` instead.
   *
   * @returns whether the probe was answered.
   */
  async probe(): Promise<boolean> {
    const result = await this.send(buildProbeEvent())
    if (result.delivered) this.handshaken = true
    return result.delivered
  }

  /**
   * Queue one event for the pet.
   *
   * @param event - the normalized event.
   * @returns delivery result; never rejects.
   */
  send(event: PetEvent): Promise<SendResult> {
    const run = async (): Promise<SendResult> => {
      const result = await postJson({
        port: this.petPort,
        path: '/event',
        body: event,
        timeoutMs: this.timeoutMs,
        signal: this.signal,
      })
      if (!result.delivered) this.log(`send ${event.event} failed: ${result.failure ?? 'unknown'}`)
      return result
    }
    // Chain onto the tail; a failed predecessor must not break the chain, and
    // the returned promise is the one this caller cares about.
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Resolve once every queued send has settled; used on plugin unload. */
  async drain(): Promise<void> {
    await this.queue.catch(() => undefined)
  }
}

/**
 * Build a `/hello` acknowledgement for the pet.
 *
 * The negotiation is deliberately one-sided and tiny (PL-PR-NW-02): the host
 * advertises {@link BRIDGE_CAPABILITIES}, and `agreed` is that set filtered by
 * what this particular pet declared. All of it is additive on v1, so a pet that
 * predates the negotiation receives the same 200 it always did, plus two fields
 * it will ignore.
 *
 * @param revision - current snapshot revision.
 * @param hello - the parsed handshake; its `capabilities` decide `agreed`.
 * @returns the response body.
 */
export function helloResponse(revision: number, hello: HelloRequest): HelloResponse {
  const declared = hello.capabilities
  return {
    v: PROTOCOL_VERSION,
    ok: true,
    revision,
    petPort: hello.port,
    capabilities: BRIDGE_CAPABILITIES,
    // The host is the arbiter: what it will rely on is its own set filtered by
    // the pet's declaration, never the pet's claim on its own.
    agreed: declared === undefined
      ? []
      : BRIDGE_CAPABILITIES.filter((capability) => declared.includes(capability)),
    ...(declared === undefined ? { legacy: true as const } : {}),
    ...(hello.petVersion === undefined ? {} : { petVersion: hello.petVersion }),
  }
}

/**
 * Validate a `/hello` body.
 *
 * @param body - parsed request body.
 * @param isPort - port validator (injected so this module stays free of the
 *   protocol's own guards in tests).
 * @returns the handshake, or a failure reason.
 */
export function parseHello(
  body: unknown,
  isPort: (value: unknown) => value is number,
): { ok: true, hello: HelloRequest } | { ok: false, reason: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body-not-object' }
  }
  const record = body as Record<string, unknown>
  if (record.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version-mismatch' }
  if (!isPort(record.port)) return { ok: false, reason: 'invalid-port' }
  const protocol = parseProtocolRange(record.protocol)
  const capabilities = parseCapabilities(record.capabilities)
  const hello: HelloRequest = {
    v: PROTOCOL_VERSION,
    port: record.port,
    ...(typeof record.petVersion === 'string' ? { petVersion: clampPlain(record.petVersion, 64) } : {}),
    ...(typeof record.token === 'string' ? { token: record.token } : {}),
    ...(protocol === undefined ? {} : { protocol }),
    ...(capabilities === undefined ? {} : { capabilities }),
  }
  return { ok: true, hello }
}

/**
 * Read the optional protocol range.
 *
 * A malformed range is dropped rather than treated as fatal: demanding agreement
 * here would turn a forward-compatible extension into a handshake failure, which
 * is the one outcome `/hello` must never produce (PL-PR-NW-02). The pet's `v`
 * check stays the real gate.
 *
 * @param value - raw field from the request body.
 * @returns the range, or undefined when absent or unusable.
 */
function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { min, max } = record
  if (!isRevision(min) || !isRevision(max) || min > max) return undefined
  return { min, max }
}

/** Whether a value could be a protocol revision number. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Read the optional capability declaration.
 *
 * Unknown names are dropped instead of rejected, for the same reason the range
 * is: a newer pet may name a capability this host has never heard of, and that
 * must still be a successful handshake. Absent or non-array yields `undefined`
 * (a legacy pet); an empty array stays an empty array, which says "aware of the
 * negotiation, implements none of it" — a different fact, and the reason the two
 * are not collapsed here.
 *
 * @param value - raw field from the request body.
 * @returns the recognized capabilities in the protocol's own order, or undefined.
 */
function parseCapabilities(value: unknown): BridgeCapability[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<BridgeCapability>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const capability = BRIDGE_CAPABILITIES.find((candidate) => candidate === item)
    if (capability !== undefined) seen.add(capability)
  }
  return BRIDGE_CAPABILITIES.filter((capability) => seen.has(capability))
}

/** Bound a plain string field without pulling in the title-oriented helper. */
function clampPlain(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit)
}

/**
 * Build the liveness probe sent when the plugin mounts.
 *
 * It is an ordinary `idle` event with no session attached: a pet that receives
 * it learns DSH is up, and its answer is what tells the plugin the pet is
 * already listening.
 *
 * @returns the probe event.
 */
export function buildProbeEvent(): PetEvent {
  return {
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    event: 'idle',
    source: EVENT_SOURCE,
    hook: 'plugin/start',
    sessionId: 'host',
    runId: null,
    targetTurnRef: null,
    timestamp: Date.now(),
    title: null,
    message: 'DSH 在线',
  }
}
