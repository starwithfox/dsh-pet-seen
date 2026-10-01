/**
 * A DSH WebServer double.
 *
 * `mountBrowserRoutes()` registers three `exact` handlers and never touches the
 * rest of the WebServer surface, so the double only has to keep the handlers and
 * be able to invoke one. That makes the route tests call the shipping handler
 * without binding a socket — and lets the integration suite mount the real
 * routes on a host that otherwise runs headless.
 *
 * `req` is only as real as a handler needs: a method, a URL, headers, and an
 * async iterator for the body. `res` records the status line and the payload
 * instead of writing to one.
 *
 * @module tests/web-server-fixture
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerFace } from '../src/routes.js'

/** One call into a registered handler. */
export interface RouteCall {
  readonly method: string
  readonly path: string
  readonly body?: Record<string, unknown>
  /** `null` sends no `Origin` header at all; the default is same-origin. */
  readonly origin?: string | null
}

/** The response a stubbed handler produced. */
export interface RouteAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** A WebServer double, with a way to call what was registered. */
export interface FakeWebServer {
  readonly face: WebServerFace
  readonly call: (call: RouteCall) => Promise<RouteAnswer>
  /** Registered paths, in registration order. */
  readonly registered: () => string[]
}

/** Build a WebServer double. Each call gets its own handler table. */
export function fakeWebServer(): FakeWebServer {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const face: WebServerFace = {
    register: (route) => {
      handlers.set(route.path, route.handler)
      return () => { handlers.delete(route.path) }
    },
  }
  const call = async ({ method, path, body, origin = 'http://127.0.0.1:19387' }: RouteCall): Promise<RouteAnswer> => {
    const handler = handlers.get(path)
    assert.ok(handler !== undefined, `no handler registered for ${path}`)
    const text = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { host: '127.0.0.1:19387' }
    if (origin !== null) headers.origin = origin
    const req = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        if (text !== '') yield Buffer.from(text, 'utf8')
      },
    } as unknown as IncomingMessage
    let status = 0
    let payload = ''
    const res = {
      writeHead: (code: number) => { status = code },
      end: (chunk?: unknown) => { payload = typeof chunk === 'string' ? chunk : String(chunk ?? '') },
    } as unknown as ServerResponse
    await handler(req, res)
    return { status, body: payload === '' ? {} : JSON.parse(payload) as Record<string, unknown> }
  }
  return { face, call, registered: () => [...handlers.keys()] }
}
