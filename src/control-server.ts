/**
 * The control plane the pet talks to: a loopback HTTP listener that is *not*
 * the DSH WebServer.
 *
 * Why a second listener instead of reusing the DSH port: the DSH WebServer is
 * the browser's carrier — its routes live inside the page's origin and its
 * same-origin defence. The pet is a non-browser local process, so making it
 * speak the page's namespace would couple it to the harness's HTTP surface for
 * no gain. This listener has one job, dies with the plugin, and its liveness
 * *is* the pet's "is DSH up" signal.
 *
 * Security posture:
 *
 * - Bound to `127.0.0.1` only, never `0.0.0.0`. Loopback-only is not
 *   authentication — any local process can connect — which is why a bearer
 *   token is required as well.
 * - The token is minted per host process, so a token from a previous process is
 *   rejected, and it is written 0600 to `~/.dsh/pet-bridge.json` for the pet.
 * - Path, method, body size, token, and body shape are all checked before any
 *   plugin work happens. A control port that is already taken disables the
 *   bridge loudly instead of leaking a token to whoever owns the port.
 *
 * @module dsh-pet-seen/control-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  CONTROL_ROUTES,
  MAX_REQUEST_BODY_BYTES,
  PROTOCOL_VERSION,
  isLoopbackHost,
  isPort,
} from './protocol.js'
import type { AckResponse, JsonObject, NoticeState, StatePayload } from './protocol.js'
import { helloResponse, parseHello } from './pet-client.js'

/** Collaborators the control server needs from the plugin. */
export interface ControlServerDeps {
  /** Port to bind; 0 lets the OS choose (used by tests). */
  readonly port: number
  /** Builds the current `/state` body. */
  readonly statePayload: () => StatePayload
  /** Records the pet's reported port. */
  readonly onHello: (port: number) => void
  /** Applies a pet acknowledgement; returns the resulting state, or null. */
  readonly onAck: (noticeId: string, action: 'shown' | 'dismissed') => NoticeState | null
  /**
   * Reports the outcome of the bind attempt. `port` is the resolved port on
   * success and `null` when the listener could not start, so a caller can react
   * to a taken port without polling.
   */
  readonly onBound?: (result:
    | { readonly ok: true, readonly port: number }
    | { readonly ok: false, readonly reason: string }) => void
  /**
   * Path of the handshake file to publish, overriding {@link tokenFilePath}.
   *
   * A test or tool instance that binds an ephemeral port **must** set this:
   * otherwise it would overwrite the credentials of a bridge that is already
   * serving a real host process. See {@link startControlServer} for the rule.
   */
  readonly tokenFile?: string
  /** Optional diagnostic sink. */
  readonly log?: (message: string) => void
}

/** A running control listener. */
export interface ControlServer {
  /** Actual bound port (resolved when the requested port was 0). */
  readonly port: number
  /** Bearer token the pet must present. */
  readonly token: string
  /** Close the listener. */
  readonly close: () => Promise<void>
}

/**
 * Where the handshake file lives for the pet to read.
 *
 * @param override - explicit path to use instead of the shared user path.
 * @returns the override, or `~/.dsh/pet-bridge.json`.
 */
export function tokenFilePath(override?: string): string {
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.dsh', 'pet-bridge.json')
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

/** Parse a body into a plain object, or null. */
function parseObject(text: string): JsonObject | null {
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as JsonObject
  } catch {
    return null
  }
}

/** Extract the presented token from either a header or a query parameter. */
function presentedToken(req: IncomingMessage, query: URLSearchParams): string | null {
  const header = req.headers['x-pet-token']
  if (typeof header === 'string' && header !== '') return header
  const fromQuery = query.get('token')
  return fromQuery === null || fromQuery === '' ? null : fromQuery
}

/**
 * Write the handshake file with owner-only permissions.
 *
 * A failure is reported but never fatal: an already-configured pet keeps
 * working, and a fresh pet simply sees no token.
 *
 * @param port - the bound control port.
 * @param token - the minted bearer token.
 * @param override - explicit destination; defaults to {@link tokenFilePath}.
 * @returns an error message when writing failed, else null.
 */
export function writeTokenFile(port: number, token: string, override?: string): string | null {
  const path = tokenFilePath(override)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const staged = `${path}.tmp`
    writeFileSync(staged, `${JSON.stringify({
      v: PROTOCOL_VERSION,
      controlPort: port,
      token,
      writtenAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 })
    // Rename over the old file so the pet never reads a half-written token.
    renameSync(staged, path)
    chmodSync(path, 0o600)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Start the control listener.
 *
 * Credential-publishing rule: the shared handshake file is written **only** for
 * a listener that was asked for a *specific* port. An instance with
 * `port: 0` — a test, the offline round-trip script, any throwaway — is not the
 * host's bridge, so publishing its random port and token would break whatever
 * real bridge is running (this is exactly how `npm run check` once left a live
 * DSH unreachable). Such an instance must pass `tokenFile` to opt in.
 *
 * @param deps - collaborators and bind port.
 * @returns the running server, or a failure reason when the port is unusable.
 */
export async function startControlServer(
  deps: ControlServerDeps,
): Promise<{ ok: true, server: ControlServer } | { ok: false, reason: string }> {
  const log = deps.log ?? (() => {})
  const token = randomBytes(32).toString('hex')
  const server: Server = createServer((req, res) => {
    void handle(req, res, deps, token, log)
  })
  const bound = await new Promise<{ ok: true, port: number } | { ok: false, reason: string }>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: error.code ?? 'listen-error' })
    })
    server.listen(deps.port, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        resolve({ ok: false, reason: 'no-address' })
        return
      }
      resolve({ ok: true, port: address.port })
    })
  })
  if (!bound.ok) {
    server.close()
    log(`control listener failed: ${bound.reason}`)
    deps.onBound?.({ ok: false, reason: bound.reason })
    return bound
  }
  const ephemeral = deps.port === 0 && (deps.tokenFile === undefined || deps.tokenFile === '')
  const writeError = ephemeral
    ? (log('ephemeral control port: not publishing credentials to the shared path'
        + ` (${tokenFilePath()}); pass \`tokenFile\` to publish elsewhere`), null)
    : writeTokenFile(bound.port, token, deps.tokenFile)
  if (writeError !== null) log(`could not write ${tokenFilePath(deps.tokenFile)}: ${writeError}`)
  log(`control listener on 127.0.0.1:${bound.port}`)
  deps.onBound?.({ ok: true, port: bound.port })
  return {
    ok: true,
    server: {
      port: bound.port,
      token,
      close: () => new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => { resolve() })
      }),
    },
  }
}

/** Dispatch one control request. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  token: string,
  log: (message: string) => void,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) {
    sendJson(res, 403, { v: PROTOCOL_VERSION, ok: false, reason: 'non-loopback-host' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === CONTROL_ROUTES.state) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { v: PROTOCOL_VERSION, ok: false, reason: 'method-not-allowed' })
      return
    }
    // `/state` enumerates sessions, so the token gates it too.
    if (presentedToken(req, url.searchParams) !== token) {
      sendJson(res, 401, { v: PROTOCOL_VERSION, ok: false, reason: 'unauthorized' })
      return
    }
    sendJson(res, 200, deps.statePayload())
    return
  }

  if (path !== CONTROL_ROUTES.hello && path !== CONTROL_ROUTES.ack) {
    sendJson(res, 404, { v: PROTOCOL_VERSION, ok: false, reason: 'not-found' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { v: PROTOCOL_VERSION, ok: false, reason: 'method-not-allowed' })
    return
  }
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
  if (body.token !== token) {
    // Deliberately vague: a caller probing tokens learns nothing.
    sendJson(res, 401, { v: PROTOCOL_VERSION, ok: false, reason: 'unauthorized' })
    return
  }

  if (path === CONTROL_ROUTES.hello) {
    const parsed = parseHello(body, isPort)
    if (!parsed.ok) {
      sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: parsed.reason })
      return
    }
    deps.onHello(parsed.hello.port)
    const revision = deps.statePayload().revision
    const negotiated = helloResponse(revision, parsed.hello)
    // The negotiation is only worth reporting if it is visible somewhere: the
    // pet reads `agreed` off the response, and a human reads it here. Legacy is
    // said out loud because "no declaration" and "declared none" are different
    // facts that would otherwise look identical in a log (PL-PR-NW-02).
    const declared = parsed.hello.capabilities
    const range = parsed.hello.protocol
    log(
      `hello accepted: ${declared === undefined ? 'legacy pet (no capability declaration)' : `declared ${declared.join(',') || 'none'}`}`
      + `${range === undefined ? '' : `, speaks v${range.min}..v${range.max}`}`
      + `; host agrees on ${negotiated.agreed.join(',') || 'nothing'}`,
    )
    sendJson(res, 200, negotiated)
    return
  }

  const noticeId = typeof body.noticeId === 'string' ? body.noticeId : ''
  const action = body.action === 'shown' || body.action === 'dismissed' ? body.action : null
  if (noticeId === '' || action === null) {
    sendJson(res, 400, { v: PROTOCOL_VERSION, ok: false, reason: 'invalid-ack' })
    return
  }
  const state = deps.onAck(noticeId, action)
  if (state === null) {
    log(`ack for unknown notice ${noticeId} ignored`)
    sendJson(res, 404, { v: PROTOCOL_VERSION, ok: false, reason: 'unknown-notice' })
    return
  }
  const payload: AckResponse = { v: PROTOCOL_VERSION, ok: true, state }
  sendJson(res, 200, payload)
}
