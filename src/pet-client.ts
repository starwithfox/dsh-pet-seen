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
 * @module dsh-pet-bridge/pet-client
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { EVENT_SOURCE, PROTOCOL_VERSION, MAX_RESPONSE_BODY_BYTES } from './protocol.js'
import type { HelloRequest, PetEvent } from './protocol.js'

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
 * @param revision - current snapshot revision.
 * @param petPort - port the pet should keep listening on.
 * @returns the response body.
 */
export function helloResponse(revision: number, petPort: number): {
  v: typeof PROTOCOL_VERSION
  ok: true
  revision: number
  petPort: number
} {
  return { v: PROTOCOL_VERSION, ok: true, revision, petPort }
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
  const hello: HelloRequest = {
    v: PROTOCOL_VERSION,
    port: record.port,
    ...(typeof record.petVersion === 'string' ? { petVersion: clampPlain(record.petVersion, 64) } : {}),
    ...(typeof record.token === 'string' ? { token: record.token } : {}),
  }
  return { ok: true, hello }
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
