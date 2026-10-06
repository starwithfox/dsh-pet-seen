/**
 * Wire validator: validate the bytes on the wire against the published schema.
 *
 * **Why this exists next to `tests/negotiation.test.ts`** (PL-TS-NW-03 判据 ②).
 * That test compares two *declarations* — `protocol/bridge-v1.schema.json` against
 * the TypeScript types in `src/protocol.ts`. It cannot see what the host actually
 * emits. This tool drives the **real plugin** (`lib/index.js`) over the **real
 * transports** and validates every captured payload against that schema. A probe
 * that reddens one of the two must leave the other green, or they are the same check.
 *
 * **What is real here, and what is not** — read this before quoting the output:
 *
 *   - `host -> pet` bytes (`/event`, and the responses to `/hello` `/state` `/ack`)
 *     are produced by `lib/index.js` itself. They are the real sender.
 *   - `pet -> host` bytes (`/hello`, `/ack` requests) are authored by this harness.
 *     They prove the schema describes what a receiver *must* send and that the host
 *     accepts it; they are **not** an independent implementation's bytes. The real
 *     independent implementation's bytes were exercised live in T3 (see
 *     `working-docs/HANDOFF-PL-TS-NW-03.md` §9).
 *
 * Usage: npm run wire:check
 *
 * @module tools/validate-bridge-wire
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { apply, PROTOCOL_VERSION } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

const SCHEMA_PATH = join(root, 'protocol', 'bridge-v1.schema.json')
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

/**
 * Messages the schema publishes no `$defs` for, with the code that owns the gap.
 *
 * An exemption must be **explicit and must not go stale**: a message that is not
 * on this list fails the run, and an entry whose message has since been given a
 * `$defs` also fails the run (the same rule the docs gate uses for references).
 */
const UNCOVERED_ALLOWLIST = new Map([
  ['/event response', 'IS-066 / PL-PR-NW-07'],
])

/* ------------------------------------------------------------ the validator */

/**
 * Schema keywords this validator implements. Anything else in the schema is a
 * hard error: a validator that silently ignores a keyword it does not know
 * reports "green" for a constraint nobody checked, which is worse than no check.
 */
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'title', 'description',
  'type', '$ref', 'required', 'properties', 'additionalProperties',
  'const', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength',
  'maxItems', 'uniqueItems', 'items', 'oneOf',
])

/** Keywords allowed only at the document root (not inside `$defs`). */
const ROOT_ONLY_KEYWORDS = new Set(['$schema', '$id', 'x-endpoints'])

/**
 * Assert the schema only uses keywords this validator implements.
 *
 * @param node - a schema node.
 * @param where - JSON pointer-ish location, for the error message.
 */
function auditKeywords(node, where) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (ROOT_ONLY_KEYWORDS.has(key)) continue
    if (key === 'properties' || key === '$defs') {
      for (const [name, child] of Object.entries(value)) auditKeywords(child, `${where}/${key}/${name}`)
      continue
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`validator does not implement the schema keyword "${key}" at ${where}; ` +
        'add it here before trusting a green run')
    }
    if (key === 'items' || key === 'additionalProperties') {
      if (typeof value === 'object' && value !== null) auditKeywords(value, `${where}/${key}`)
      continue
    }
    if (key === 'oneOf') {
      value.forEach((child, index) => auditKeywords(child, `${where}/oneOf/${index}`))
      continue
    }
  }
}
auditKeywords(schema, '#')

/** JSON types, matching the draft's base vocabulary. */
function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function checkType(value, expected) {
  const actual = typeOf(value)
  // `type` may be a single name or a list of alternatives (the published schema
  // uses lists such as ["string","null"] for every optional field).
  const wanted = Array.isArray(expected) ? expected : [expected]
  return wanted.some((name) => {
    if (name === 'number') return actual === 'number' || actual === 'integer'
    return actual === name
  })
}

/**
 * Validate `value` against `node`.
 *
 * @param value - the decoded JSON payload.
 * @param node - a schema node.
 * @param path - location inside the payload, for messages.
 * @param errors - collects one string per violation.
 * @param refStack - guards against a `$ref` cycle.
 */
function validate(value, node, path, errors, refStack = []) {
  if (node.$ref !== undefined) {
    const name = String(node.$ref).replace('#/$defs/', '')
    if (refStack.includes(name)) return
    const target = schema.$defs[name]
    if (target === undefined) {
      errors.push(`${path}: unresolved $ref ${node.$ref}`)
      return
    }
    validate(value, target, path, errors, [...refStack, name])
    return
  }

  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter((candidate) => {
      const local = []
      validate(value, candidate, path, local, refStack)
      return local.length === 0
    })
    if (matches.length !== 1) {
      errors.push(`${path}: oneOf matched ${matches.length} branches (exactly 1 required)`)
    }
    return
  }

  if (node.type !== undefined && !checkType(value, node.type)) {
    errors.push(`${path}: expected ${JSON.stringify(node.type)}, got ${typeOf(value)}`)
    return
  }
  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`)
  }
  if (node.enum !== undefined && !node.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`)
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: ${value} < minimum ${node.minimum}`)
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: ${value} > maximum ${node.maximum}`)
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (node.minLength !== undefined && length < node.minLength) errors.push(`${path}: length ${length} < minLength ${node.minLength}`)
    if (node.maxLength !== undefined && length > node.maxLength) errors.push(`${path}: length ${length} > maxLength ${node.maxLength}`)
  }
  if (Array.isArray(value)) {
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push(`${path}: ${value.length} items > maxItems ${node.maxItems}`)
    }
    if (node.uniqueItems === true) {
      const seen = new Set()
      value.forEach((item, index) => {
        const key = JSON.stringify(item)
        if (seen.has(key)) errors.push(`${path}[${index}]: duplicate item (uniqueItems)`)
        seen.add(key)
      })
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => validate(item, node.items, `${path}[${index}]`, errors, refStack))
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const name of node.required ?? []) {
      if (!(name in value)) errors.push(`${path}: missing required property "${name}"`)
    }
    const declared = node.properties ?? {}
    for (const [name, child] of Object.entries(value)) {
      if (declared[name] !== undefined) {
        validate(child, declared[name], `${path}.${name}`, errors, refStack)
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${name}" (additionalProperties: false)`)
      } else if (typeof node.additionalProperties === 'object' && node.additionalProperties !== null) {
        validate(child, node.additionalProperties, `${path}.${name}`, errors, refStack)
      }
    }
  }
}

/**
 * Validate a captured payload against a named `$defs` entry.
 *
 * @param defName - key in `$defs`.
 * @param payload - decoded JSON payload.
 * @returns list of violations (empty means valid).
 */
function validateAgainst(defName, payload) {
  const def = schema.$defs[defName]
  if (def === undefined) throw new Error(`no $defs/${defName} in the schema`)
  const errors = []
  validate(payload, def, '$', errors)
  return errors
}

/* --------------------------------------------------------------- the wire */

/** Every message captured on the wire, in the order it crossed. */
const captured = []

const scratch = mkdtempSync(join(tmpdir(), 'dsh-pet-seen-wire-'))

/**
 * The fake pet: it records the raw bytes of everything the host pushes, and
 * answers with a body — so the response bytes are captured too.
 */
const petServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (path !== '/event' || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"v":1,"ok":false,"reason":"no such route"}')
      return
    }
    captured.push({ label: '/event request', direction: 'host -> pet', def: 'PetEvent', raw })
    const reply = JSON.stringify({ v: PROTOCOL_VERSION, ok: true })
    captured.push({ label: '/event response', direction: 'pet -> host', def: null, raw: reply })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(reply)
  })
})
const petPort = await new Promise((resolve) => {
  petServer.listen(0, '127.0.0.1', () => resolve(petServer.address().port))
})

/* ---- fake DSH: the smallest harness the plugin needs to run in-process ---- */

let emitStatus = () => {}
let emitEvent = () => {}
let controlPort = null
let controlToken = null
const routes = new Map()
const webServer = {
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => { routes.delete(route.path) }
  },
}
const disposers = []
const ctx = {
  on: (name, listener) => {
    if (name === 'agent/status') emitStatus = listener
    if (name === 'session/event') emitEvent = listener
    return () => true
  },
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  inject: (names, callback) => {
    if (!names.includes('webServer')) return
    callback({
      get: (name) => (name === 'webServer' ? webServer : undefined),
      effect: (cb) => {
        const disposer = cb()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
    })
    return () => {}
  },
  logger: { info: () => {}, warn: () => {} },
}

apply(ctx, {
  controlPort: 0,
  tokenFile: join(scratch, 'pet-bridge.json'),
  petPort,
  notifyDelayMs: 0,
  petEventTimeoutMs: 1000,
  idleGraceMs: 200,
  seenDwellMs: 20,
  maxNotices: 50,
  noticeTtlMs: 3_600_000,
  includeTitle: true,
}, {
  onReady: (hooks) => {
    hooks.onControlBound((result) => {
      if (!result.ok) throw new Error(`control listener failed: ${result.reason}`)
      controlPort = result.port
      controlToken = result.token
    })
  },
})

async function waitFor(check, label, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}
await waitFor(() => controlPort !== null, 'the control listener')

/**
 * POST to the control listener and capture the raw request and response bytes.
 *
 * @param path - control route.
 * @param payload - request body, exactly as it will be serialized.
 * @param defs - `$defs` names for the request and the response.
 */
async function captureControlPost(path, payload, [requestDef, responseDef]) {
  const raw = JSON.stringify(payload)
  captured.push({ label: `${path} request`, direction: 'pet -> host', def: requestDef, raw })
  const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
  const text = await response.text()
  captured.push({ label: `${path} response`, direction: 'host -> pet', def: responseDef, raw: text })
  return { status: response.status, text }
}

/**
 * GET a control route and capture the raw response bytes.
 *
 * @param path - control route.
 * @param responseDef - `$defs` name for the response.
 */
async function captureControlGet(path, responseDef) {
  const response = await fetch(`http://127.0.0.1:${controlPort}${path}?token=${encodeURIComponent(controlToken)}`)
  const text = await response.text()
  captured.push({ label: `${path} response`, direction: 'host -> pet', def: responseDef, raw: text })
  return { status: response.status, text }
}

/* --------------------------------------------------------------- the drive */

const helloRequest = {
  v: PROTOCOL_VERSION,
  petVersion: 'validate-bridge-wire',
  port: petPort,
  token: controlToken,
  protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
  capabilities: ['events', 'state-sync', 'ack-shown', 'ack-dismissed', 'notice-seen'],
}
const hello = await captureControlPost('/hello', helloRequest, ['HelloRequest', 'HelloResponse'])
if (hello.status !== 200) throw new Error(`/hello failed: ${hello.status} ${hello.text}`)

const session = { id: 'wire-session', header: { cwd: process.cwd(), title: 'wire validation' } }
const before = captured.filter((item) => item.label === '/event request').length
const now = Date.now()
emitStatus({ agent: { session, status: 'running' }, status: 'running' })
emitEvent(session, { type: 'turn/start', seq: 10, time: now, data: { turn: 1 } })
emitEvent(session, {
  type: 'tool/call', seq: 11, time: now, data: { callId: 'c1', name: 'grep', arguments: '{"pattern":"SECRET"}' },
})
emitEvent(session, { type: 'turn/end', seq: 12, time: now, data: { turn: 1, reason: { kind: 'completed' } } })
emitStatus({ agent: { session, status: 'idle' }, status: 'idle' })
await waitFor(
  () => captured.filter((item) => item.label === '/event request').length > before,
  'the completion push',
)

const eventPayload = JSON.parse(captured.filter((item) => item.label === '/event request').at(-1).raw)
if (typeof eventPayload.noticeId !== 'string' || eventPayload.noticeId === '') {
  throw new Error('the pushed event carried no noticeId; cannot exercise /ack')
}

await captureControlPost(
  '/ack',
  { v: PROTOCOL_VERSION, noticeId: eventPayload.noticeId, action: 'shown', token: controlToken },
  ['AckRequest', 'AckResponse'],
)
await captureControlGet('/state', 'StatePayload')

/* ------------------------------------------------------------- the verdict */

const endpoints = new Map(schema['x-endpoints'].map((item) => [`${item.method} ${item.path}`, item]))
const rows = []
const failures = []
const uncovered = []

for (const item of captured) {
  if (item.def === null) {
    // The schema publishes no `$defs` for this message. That is a gap in the
    // contract, not a pass: report it by name so it cannot be forgotten.
    uncovered.push(item)
    rows.push([item.label, item.direction, '(no $defs)', 'UNCOVERED'])
    continue
  }
  const payload = JSON.parse(item.raw)
  const errors = validateAgainst(item.def, payload)
  rows.push([item.label, item.direction, item.def, errors.length === 0 ? 'ok' : `${errors.length} violation(s)`])
  for (const error of errors) failures.push(`${item.label} -> ${item.def} ${error}`)
}

// Every endpoint the schema publishes must have been exercised, so a new
// endpoint cannot be added to the contract and silently skipped here.
const exercised = new Set()
for (const item of captured) {
  const route = item.label.split(' ')[0]
  for (const [key, endpoint] of endpoints) {
    if (endpoint.path === route) exercised.add(key)
  }
}
const unexercised = [...endpoints.keys()].filter((key) => !exercised.has(key))

const width = Math.max(...rows.map((row) => row[0].length))
const uncoveredLabels = new Set(uncovered.map((item) => item.label))
const unexpectedUncovered = [...uncoveredLabels].filter((label) => !UNCOVERED_ALLOWLIST.has(label))
const staleExemptions = [...UNCOVERED_ALLOWLIST.keys()].filter((label) => !uncoveredLabels.has(label))
console.log(`schema      ${SCHEMA_PATH.replace(`${root}\\`, '').replace(`${root}/`, '')}`)
console.log(`keywords    ${SUPPORTED_KEYWORDS.size} implemented, ${schema.$defs ? Object.keys(schema.$defs).length : 0} $defs audited\n`)
for (const [label, direction, def, verdict] of rows) {
  console.log(`${label.padEnd(width)}  ${direction.padEnd(10)}  ${String(def).padEnd(15)}  ${verdict}`)
}

console.log('')
if (failures.length > 0) {
  for (const failure of failures) console.log(`VIOLATION  ${failure}`)
}
for (const item of new Map(uncovered.map((entry) => [entry.label, entry])).values()) {
  const owner = UNCOVERED_ALLOWLIST.get(item.label)
  console.log(`UNCOVERED  ${item.label}: the schema publishes no $defs for it — ` +
    (owner === undefined
      ? 'NOT EXEMPT (add it to UNCOVERED_ALLOWLIST with the code that owns the gap)'
      : `known gap, owned by ${owner}`))
}
for (const label of staleExemptions) {
  console.log(`STALE      ${label}: exempted in UNCOVERED_ALLOWLIST but now covered by the schema — ` +
    'remove the exemption')
}
for (const key of unexercised) console.log(`NOT DRIVEN ${key}: declared in x-endpoints but never captured`)

const ok = failures.length === 0
  && unexercised.length === 0
  && unexpectedUncovered.length === 0
  && staleExemptions.length === 0
console.log(`\nVERDICT: ${ok ? 'PASS' : 'FAIL'} ` +
  `(${rows.length - uncovered.length} messages validated, ${uncovered.length} uncovered, ${failures.length} violations)`)

// Shut down in an orderly way: closing the pet server and running the plugin's
// disposers first keeps Node from tearing down libuv with handles mid-close
// (which aborts on Windows instead of exiting).
await new Promise((resolve) => petServer.close(resolve))
for (const disposer of disposers) {
  try { disposer() } catch { /* the plugin is shutting down anyway */ }
}
rmSync(scratch, { recursive: true, force: true })
await new Promise((resolve) => setTimeout(resolve, 50))
process.exit(ok ? 0 : 1)
