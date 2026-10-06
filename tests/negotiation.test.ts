/**
 * The published contract and the handshake that negotiates it (PL-PR-NW-02).
 *
 * Two claims are pinned here, and they fail in different ways:
 *
 * 1. **Schema drift.** `protocol/bridge-v1.schema.json` is the published,
 *    language-independent spelling of what `src/protocol.ts` defines. Nothing
 *    generates one from the other — there is no validator dependency, and the
 *    package ships no runtime dependencies at all — so the lock is this test:
 *    a compile-time key check against the interfaces plus a runtime comparison
 *    against the schema. Changing one side alone turns this red.
 * 2. **Negotiation is additive.** A legacy pet (no `capabilities` field) keeps
 *    the handshake and the push path it always had, and a pet that declares a
 *    subset gets an honest `agreed` — never the host's own set dressed up as
 *    agreement.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { bridge } from './harness.js'
import type {
  AckRequest,
  AckResponse,
  HelloRequest,
  HelloResponse,
  NoticeSnapshot,
  PetEvent,
  SessionProgressSnapshot,
  StatePayload,
  TabDiagnostic,
  TurnEndRecord,
} from '../src/protocol.js'

const {
  BRIDGE_CAPABILITIES,
  PET_EVENT_NAMES,
  PROTOCOL_VERSION,
  RESERVED_PET_EVENT_NAMES,
  helloResponse,
  isPort,
  parseHello,
} = bridge

/** One `$defs` entry, narrowed to the parts these locks read. */
interface SchemaDef {
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
  readonly enum?: readonly unknown[]
  readonly oneOf?: readonly { readonly title?: string, readonly enum?: readonly unknown[], readonly description?: string }[]
}

interface Schema {
  readonly $defs: Record<string, SchemaDef>
  readonly 'x-endpoints': readonly { readonly path: string, readonly note?: string }[]
}

const schema = JSON.parse(
  readFileSync(new URL('../../protocol/bridge-v1.schema.json', import.meta.url), 'utf8'),
) as Schema

/**
 * Field lock, both directions.
 *
 * `Exclude<keyof T, Keys>` catches a field added to the interface but not to the
 * list; `Exclude<Keys, keyof T>` catches a listed name the interface does not
 * have. Either way the member type below becomes `never`, and `true` stops being
 * assignable to it — a compile error rather than a silent gap.
 */
type Exact<Keys extends string, T> = [Exclude<keyof T, Keys>, Exclude<Keys, keyof T>] extends [never, never]
  ? true
  : never

const PET_EVENT_FIELDS = [
  'v', 'id', 'event', 'source', 'hook', 'sessionId', 'runId', 'targetTurnRef',
  'timestamp', 'title', 'message', 'tool', 'reason', 'seen', 'noticeId',
] as const
const HELLO_REQUEST_FIELDS = ['v', 'petVersion', 'port', 'token', 'protocol', 'capabilities'] as const
const HELLO_RESPONSE_FIELDS = [
  'v', 'ok', 'revision', 'petPort', 'capabilities', 'agreed', 'legacy', 'petVersion',
] as const
const ACK_REQUEST_FIELDS = ['v', 'noticeId', 'action', 'token'] as const
const ACK_RESPONSE_FIELDS = ['v', 'ok', 'state', 'reason'] as const
const TURN_END_RECORD_FIELDS = ['turn', 'kind', 'at'] as const
const SESSION_ROW_FIELDS = [
  'sessionId', 'title', 'cwd', 'origin', 'running', 'runId', 'lastTurnEnd', 'toolCalls',
  'lastTool', 'todoCount', 'completedTodoCount', 'percent', 'updatedAt', 'reader',
] as const
const NOTICE_ROW_FIELDS = [
  'noticeId', 'sessionId', 'runId', 'targetTurnRef', 'reason', 'completedAt', 'state',
  'seenAt', 'delivered',
] as const
const TAB_ROW_FIELDS = ['tabId', 'sessionId', 'reader', 'readerReason', 'byIdCount', 'buildId', 'at'] as const
const STATE_FIELDS = [
  'v', 'revision', 'sessions', 'notices', 'petPort', 'browserRoutes', 'buildId',
  'pluginVersion', 'browserTabs',
] as const

/** Every message shape the schema publishes, keyed the same as `$defs`. */
const fieldLocks: {
  PetEvent: Exact<(typeof PET_EVENT_FIELDS)[number], PetEvent>
  HelloRequest: Exact<(typeof HELLO_REQUEST_FIELDS)[number], HelloRequest>
  HelloResponse: Exact<(typeof HELLO_RESPONSE_FIELDS)[number], HelloResponse>
  AckRequest: Exact<(typeof ACK_REQUEST_FIELDS)[number], AckRequest>
  AckResponse: Exact<(typeof ACK_RESPONSE_FIELDS)[number], AckResponse>
  TurnEndRecord: Exact<(typeof TURN_END_RECORD_FIELDS)[number], TurnEndRecord>
  SessionProgressSnapshot: Exact<(typeof SESSION_ROW_FIELDS)[number], SessionProgressSnapshot>
  NoticeSnapshot: Exact<(typeof NOTICE_ROW_FIELDS)[number], NoticeSnapshot>
  TabDiagnostic: Exact<(typeof TAB_ROW_FIELDS)[number], TabDiagnostic>
  StatePayload: Exact<(typeof STATE_FIELDS)[number], StatePayload>
} = {
  PetEvent: true,
  HelloRequest: true,
  HelloResponse: true,
  AckRequest: true,
  AckResponse: true,
  TurnEndRecord: true,
  SessionProgressSnapshot: true,
  NoticeSnapshot: true,
  TabDiagnostic: true,
  StatePayload: true,
}

/** Properties of a `$defs` entry, or a failure naming the def. */
function propertiesOf(name: string): Record<string, unknown> {
  const def = schema.$defs[name]
  assert.ok(def?.properties !== undefined, `$defs/${name} must exist and declare properties`)
  return def.properties
}

/** Property names of a `$defs` entry, compared against a locked field list. */
function assertFields(name: string, fields: readonly string[]): void {
  assert.deepEqual(
    Object.keys(propertiesOf(name)).sort(),
    [...fields].sort(),
    `$defs/${name} property list drifted from the locked TS interface (PL-PR-NW-02)`,
  )
}

describe('published schema ⇄ src/protocol.ts drift lock (PL-PR-NW-02)', () => {
  it('is a valid JSON document with the endpoints a pet implements', () => {
    assert.equal(typeof schema.$defs, 'object')
    assert.deepEqual(
      schema['x-endpoints'].map((endpoint) => endpoint.path).sort(),
      ['/ack', '/event', '/hello', '/state'],
    )
  })

  it('keeps every message shape field-for-field with its interface', () => {
    // `fieldLocks` above already refuses to compile when a key is missing on
    // either side; this is the runtime half, against the schema file itself.
    assert.equal(Object.keys(fieldLocks).length, 10)
    assertFields('PetEvent', PET_EVENT_FIELDS)
    assertFields('HelloRequest', HELLO_REQUEST_FIELDS)
    assertFields('HelloResponse', HELLO_RESPONSE_FIELDS)
    assertFields('AckRequest', ACK_REQUEST_FIELDS)
    assertFields('AckResponse', ACK_RESPONSE_FIELDS)
    assertFields('TurnEndRecord', TURN_END_RECORD_FIELDS)
    assertFields('SessionProgressSnapshot', SESSION_ROW_FIELDS)
    assertFields('NoticeSnapshot', NOTICE_ROW_FIELDS)
    assertFields('TabDiagnostic', TAB_ROW_FIELDS)
    assertFields('StatePayload', STATE_FIELDS)
  })

  it('publishes the same capability vocabulary the host advertises', () => {
    assert.deepEqual(schema.$defs.BridgeCapability?.enum, [...BRIDGE_CAPABILITIES])
    for (const def of ['HelloRequest', 'HelloResponse'] as const) {
      const properties = propertiesOf(def)
      for (const field of ['capabilities', 'agreed'] as const) {
        const property = properties[field] as { readonly items?: { readonly $ref?: string } } | undefined
        if (property === undefined) continue
        assert.equal(
          property.items?.$ref,
          '#/$defs/BridgeCapability',
          `${def}.${field} must reference the shared capability vocabulary`,
        )
      }
    }
  })

  it('splits the event enum into implemented and reserved', () => {
    const event = propertiesOf('PetEvent').event as SchemaDef
    const oneOf = event.oneOf
    assert.ok(Array.isArray(oneOf), 'PetEvent.event must be a grouped enum')
    assert.equal(oneOf.length, 2)
    const [implemented, reserved] = oneOf
    assert.equal(implemented?.title, 'implemented')
    assert.deepEqual(implemented?.enum, [...PET_EVENT_NAMES])
    assert.equal(reserved?.title, 'reserved')
    assert.deepEqual(reserved?.enum, [...RESERVED_PET_EVENT_NAMES])
    // The reserved group must state its owner and its debt; a bare enum would
    // read as a capability that exists (IS-014, PL-PR-IV-01).
    assert.match(reserved?.description ?? '', /PL-PR-IV-01/)
    assert.match(reserved?.description ?? '', /never sends it|IS-014/)
  })

  it('pins the closed vocabularies both halves switch on', () => {
    assert.deepEqual(schema.$defs.TurnEndKind?.enum, [
      'completed', 'aborted', 'blocked', 'error', 'forked', 'max-tokens', 'interrupted', 'unknown',
    ])
    assert.deepEqual(schema.$defs.NoticeState?.enum, ['pending', 'shown', 'seen', 'dismissed'])
    assert.deepEqual(schema.$defs.SessionReaderIndex?.enum, [-1, 0, 1, 2, 3])
    const action = propertiesOf('AckRequest').action as SchemaDef
    assert.deepEqual(action.enum, ['shown', 'dismissed'])
  })

  it('requires exactly the fields the parser refuses to do without', () => {
    assert.deepEqual(schema.$defs.HelloRequest?.required, ['v', 'port'])
    assert.deepEqual(schema.$defs.AckRequest?.required, ['v', 'noticeId', 'action'])
    assert.deepEqual(schema.$defs.AckResponse?.required, ['v', 'ok'])
    assert.deepEqual(schema.$defs.HelloResponse?.required, [
      'v', 'ok', 'revision', 'petPort', 'capabilities', 'agreed',
    ])
    for (const name of ['PetEvent', 'HelloRequest', 'HelloResponse', 'AckRequest', 'AckResponse', 'StatePayload']) {
      for (const field of schema.$defs[name]?.required ?? []) {
        assert.ok(field in propertiesOf(name), `${name}.required names ${field}, which has no property`)
      }
    }
  })

  it('declares every object as tolerant of unknown fields', () => {
    // Compatibility rule (4), asserted rather than only described: additive
    // fields are free only because receivers ignore what they do not know.
    for (const [name, def] of Object.entries(schema.$defs)) {
      const candidate = def as SchemaDef & { readonly additionalProperties?: unknown, readonly type?: unknown }
      if (candidate.type !== 'object') continue
      assert.equal(candidate.additionalProperties, true, `$defs/${name} must ignore unknown fields`)
    }
  })

  it('keeps the second receiver in step with the vocabulary', () => {
    // `tools/mock-pet.mjs` is a real second implementation of the pet half, the
    // way `pet.py` is: it must not import `src/`, so its list is compared by
    // value instead of by reference.
    const source = readFileSync(new URL('../../tools/mock-pet.mjs', import.meta.url), 'utf8')
    const match = /const CAPABILITIES = \[([^\]]*)\]/.exec(source)
    assert.ok(match !== null, 'tools/mock-pet.mjs must declare a CAPABILITIES list')
    const declared = [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1])
    assert.deepEqual(declared, [...BRIDGE_CAPABILITIES])
  })
})

describe('handshake negotiation (PL-PR-NW-02)', () => {
  const helloOf = (body: unknown): HelloRequest => {
    const parsed = parseHello(body, isPort)
    if (!parsed.ok) throw new Error(`expected a parsed handshake, got ${parsed.reason}`)
    return parsed.hello
  }

  it('answers a legacy pet without asking it to change', () => {
    // The exact body every pre-negotiation pet sends, including this repo's own
    // `tools/roundtrip.mjs` and the desktop pet running on this machine.
    const hello = helloOf({ v: PROTOCOL_VERSION, petVersion: 'legacy-pet', port: 17322 })
    assert.equal(hello.capabilities, undefined, 'no declaration stays no declaration')
    const response = helloResponse(7, hello)
    assert.equal(response.ok, true)
    assert.equal(response.revision, 7)
    assert.equal(response.petPort, 17322)
    assert.deepEqual(response.agreed, [], 'the host may assume nothing about a legacy pet')
    assert.equal(response.legacy, true)
    assert.equal(response.petVersion, 'legacy-pet', 'the version echo survives the negotiation')
    assert.deepEqual(response.capabilities, [...BRIDGE_CAPABILITIES])
  })

  it('agrees only on the intersection, in the protocol’s own order', () => {
    const hello = helloOf({
      v: PROTOCOL_VERSION,
      port: 17322,
      capabilities: ['ack-shown', 'events'],
    })
    const response = helloResponse(1, hello)
    assert.deepEqual(response.agreed, ['events', 'ack-shown'])
    assert.equal('legacy' in response, false, 'a pet that declared something is not legacy')
    assert.equal(
      response.agreed.includes('ack-dismissed'),
      false,
      'a capability the pet never claimed is never agreed',
    )
  })

  it('tells "declared none" apart from "declared nothing"', () => {
    // The distinction the host needs in order to say anything useful in a log,
    // and the reason an empty array is not folded into `undefined`.
    const declaredNone = helloOf({ v: PROTOCOL_VERSION, port: 17322, capabilities: [] })
    assert.deepEqual(declaredNone.capabilities, [])
    const response = helloResponse(1, declaredNone)
    assert.deepEqual(response.agreed, [])
    assert.equal('legacy' in response, false)

    const silent = helloOf({ v: PROTOCOL_VERSION, port: 17322 })
    assert.equal(silent.capabilities, undefined)
    assert.equal(helloResponse(1, silent).legacy, true)
  })

  it('drops unknown and duplicated capability names instead of failing', () => {
    const hello = helloOf({
      v: PROTOCOL_VERSION,
      port: 17322,
      capabilities: ['events', 'teleport', 'events', 42, 'state-sync'],
    })
    assert.deepEqual(hello.capabilities, ['events', 'state-sync'])
    // A newer pet naming something this host has never heard of still hands over.
    assert.equal(helloResponse(1, hello).agreed.includes('events'), true)
  })

  it('reads a well-formed protocol range and drops a broken one', () => {
    assert.deepEqual(
      helloOf({ v: PROTOCOL_VERSION, port: 17322, protocol: { min: 1, max: 2 } }).protocol,
      { min: 1, max: 2 },
    )
    for (const broken of [{ min: 2 }, { min: 3, max: 1 }, { min: 0, max: 1 }, { min: 1.5, max: 2 }, 'v1', null]) {
      const hello = helloOf({ v: PROTOCOL_VERSION, port: 17322, protocol: broken })
      assert.equal('protocol' in hello, false, `${JSON.stringify(broken)} must not become a range`)
    }
  })

  it('treats a malformed capability field as no declaration, not as an error', () => {
    for (const broken of ['events', 7, { events: true }]) {
      const hello = helloOf({ v: PROTOCOL_VERSION, port: 17322, capabilities: broken })
      assert.equal(hello.capabilities, undefined, `${JSON.stringify(broken)} must degrade to legacy`)
      assert.equal(helloResponse(1, hello).legacy, true)
    }
  })

  it('keeps the two hard failures hard', () => {
    // Everything above is additive; `v` and `port` are the handshake itself.
    assert.equal(parseHello({ v: 99, port: 17322 }, isPort).ok, false)
    assert.equal(parseHello({ v: PROTOCOL_VERSION, port: 0 }, isPort).ok, false)
    assert.equal(parseHello(null, isPort).ok, false)
  })
})
