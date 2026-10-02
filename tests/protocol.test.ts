/**
 * Protocol-level tests: the same-origin gate, the port and text bounds, and
 * the fact that the browser route table is what it claims to be.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bridge } from './harness.js'

const {
  BROWSER_ROUTES,
  BUILD_ID,
  CONTROL_ROUTES,
  DEFAULT_CONTROL_PORT,
  DEFAULT_PET_PORT,
  MAX_TITLE_LENGTH,
  NOTICE_EVENT_NAMES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  clampText,
  clampTitle,
  completionDispatch,
  isLoopbackHost,
  isPort,
  isSameOriginLoopback,
} = bridge

describe('protocol constants', () => {
  it('pins the defaults the pet is documented against', () => {
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(DEFAULT_PET_PORT, 17322)
    assert.equal(DEFAULT_CONTROL_PORT, 17323)
    // Distinct from the neighbouring dsh-desk implementation on 17321.
    assert.notEqual(DEFAULT_PET_PORT, 17321)
    assert.notEqual(DEFAULT_CONTROL_PORT, 17321)
  })

  it('keeps browser and control route namespaces apart', () => {
    assert.equal(BROWSER_ROUTES.visibility, '/pet-bridge/visibility')
    assert.equal(BROWSER_ROUTES.notices, '/pet-bridge/notices')
    assert.equal(BROWSER_ROUTES.seen, '/pet-bridge/seen')
    assert.equal(CONTROL_ROUTES.hello, '/hello')
    assert.equal(CONTROL_ROUTES.state, '/state')
    assert.equal(CONTROL_ROUTES.ack, '/ack')
    // A browser route must never collide with a control route.
    const browserPaths: string[] = Object.values(BROWSER_ROUTES)
    const controlPaths: string[] = Object.values(CONTROL_ROUTES)
    for (const path of controlPaths) {
      assert.equal(browserPaths.includes(path), false, `${path} is claimed by both namespaces`)
    }
  })
})

describe('build identity', () => {
  it('falls back to an explicit value outside a bundle instead of throwing', () => {
    /*
     * The suite compiles `src/` with plain `tsc` and runs it from `test-dist/`,
     * where no bundler ever substitutes the ambient constants — so this is the
     * `typeof` branch, and it has to be a *value* rather than a crash: a client
     * half that threw at import time would take the whole page's pet wiring with
     * it. The bundled values are a different question, and `smoke:bundle` is the
     * only place that can answer it (it recomputes the identity from the sources
     * and refuses artifacts that do not carry it).
     *
     * If this case ever fails because the fallbacks changed, that is the point:
     * both readers of the field treat a missing id and a wrong id as different
     * findings.
     */
    assert.equal(BUILD_ID, 'unbundled')
    assert.equal(PLUGIN_VERSION, '0.0.0-unbundled')
  })
})

describe('same-origin gate', () => {
  it('accepts a same-origin loopback call', () => {
    assert.equal(isSameOriginLoopback('http://127.0.0.1:3080', '127.0.0.1:3080'), true)
    assert.equal(isSameOriginLoopback('http://localhost:3080', 'localhost:3080'), true)
  })

  it('accepts a scheme difference on the same loopback host', () => {
    assert.equal(isSameOriginLoopback('https://127.0.0.1:3080', '127.0.0.1:3080'), true)
  })

  it('rejects a cross-site origin even when the host is loopback', () => {
    assert.equal(isSameOriginLoopback('http://evil.example', '127.0.0.1:3080'), false)
    assert.equal(isSameOriginLoopback('http://127.0.0.1:9999', '127.0.0.1:3080'), false)
  })

  it('rejects a remote Host outright', () => {
    assert.equal(isSameOriginLoopback(undefined, 'example.com'), false)
    assert.equal(isSameOriginLoopback('http://example.com', 'example.com'), false)
    assert.equal(isSameOriginLoopback(undefined, undefined), false)
    assert.equal(isSameOriginLoopback(undefined, ''), false)
  })

  it('accepts a missing Origin only on a loopback Host', () => {
    // A same-origin fetch always sends Origin; a missing one means a non-browser
    // caller, which the token path already covers.
    assert.equal(isSameOriginLoopback(undefined, '127.0.0.1:3080'), true)
    assert.equal(isSameOriginLoopback(undefined, 'localhost:3080'), true)
  })

  it('handles IPv6 hosts and a non-http scheme', () => {
    assert.equal(isSameOriginLoopback('http://[::1]:3080', '[::1]:3080'), true)
    assert.equal(isLoopbackHost('[::1]:3080'), true)
    assert.equal(isSameOriginLoopback('file://127.0.0.1', '127.0.0.1:3080'), false)
    assert.equal(isSameOriginLoopback('not a url', '127.0.0.1:3080'), false)
  })
})

describe('loopback host and port guards', () => {
  it('recognizes the loopback names and nothing else', () => {
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('localhost:1234'), true)
    assert.equal(isLoopbackHost('127.0.0.1:1234'), true)
    assert.equal(isLoopbackHost('0.0.0.0:1234'), false)
    assert.equal(isLoopbackHost('192.168.1.5:1234'), false)
    assert.equal(isLoopbackHost(''), false)
    assert.equal(isLoopbackHost(undefined), false)
  })

  it('accepts only a usable TCP port', () => {
    assert.equal(isPort(17322), true)
    assert.equal(isPort(1), true)
    assert.equal(isPort(65535), true)
    assert.equal(isPort(0), false)
    assert.equal(isPort(65536), false)
    assert.equal(isPort(1.5), false)
    assert.equal(isPort('17322'), false)
    assert.equal(isPort(Number.NaN), false)
  })
})

describe('text bounds', () => {
  it('clamps with an ellipsis and drops empty input', () => {
    assert.equal(clampText('abc', 10), 'abc')
    assert.equal(clampText('  abc  ', 10), 'abc')
    assert.equal(clampText('', 10), undefined)
    assert.equal(clampText('   ', 10), undefined)
    assert.equal(clampText(undefined, 10), undefined)
    assert.equal(clampText(null, 10), undefined)
    assert.equal(clampText('abcdef', 5), 'ab...')
  })

  it('bounds titles to the declared limit', () => {
    const bounded = clampTitle('y'.repeat(400))
    assert.equal(bounded?.length, MAX_TITLE_LENGTH)
    assert.equal(clampTitle('short'), 'short')
    assert.equal(clampTitle(null), undefined)
  })
})

describe('settled-run event mapping', () => {
  // Listed by hand on purpose. Adding a kind to `TurnEndKind` should force a
  // decision here, and the assertions below then fail until the mapping in
  // `completionDispatch` agrees with the documented `NOTICE_EVENT_NAMES`.
  const kinds = [
    'completed',
    'max-tokens',
    'error',
    'blocked',
    'aborted',
    'interrupted',
    'unknown',
  ] as const

  it('carries a notice exactly when the event is a notice event', () => {
    for (const kind of kinds) {
      const dispatch = completionDispatch(kind)
      assert.equal(
        NOTICE_EVENT_NAMES.includes(dispatch.event),
        dispatch.notice,
        `${kind} -> ${dispatch.event} must be a notice event if and only if it mints a notice`,
      )
    }
  })

  it('never announces a non-completion as a result', () => {
    for (const kind of ['aborted', 'interrupted', 'unknown'] as const) {
      const dispatch = completionDispatch(kind)
      assert.equal(dispatch.notice, false, `${kind} must not mint a notice`)
      assert.equal(dispatch.event, 'idle', `${kind} must not be announced as a result`)
    }
  })
})
