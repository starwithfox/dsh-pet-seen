/**
 * dsh-petseen probe — are DSH's two pending-interaction waterfalls observable
 * from a root-mounted plugin? (PL-PR-IV-05)
 *
 * Why this is a separate package instead of a temporary patch in `src/**`:
 * the previous runtime probe (PL-PR-IV-01) edited `src/index.ts`, which forced
 * a `npm run build` — and that probe did get compiled into a working-tree
 * artifact while another task was building the same tree. This probe is loaded
 * by the host straight out of `tools/`: no `src/**` edit, no rebuild, nothing
 * to restore, and it can be pointed at either profile.
 *
 * What it measures — two independent routes, in one run:
 *
 *   1. the waterfalls `approval/request` and `user-questions/request`
 *      (`@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions`);
 *   2. `session/event`, filtered to `approval/asked` / `approval/decided`, plus
 *      the first sighting of every event type and of every tool name.
 *
 * Route 1 alone cannot tell "the request never happened" apart from "another
 * answerer claimed it before this listener ran" — both look like silence. Route
 * 2 is the cross-check that separates them, and it reads the question tool's
 * *real* name instead of assuming `ask_user_question`.
 *
 * Read-only by construction: no listener ever claims a request. Each one calls
 * `next()` and passes the downstream value — or the downstream rejection —
 * through unchanged, so an approval still reaches the UI answerer and its
 * outcome is not altered. The probe must be able to disprove itself: if the
 * approval comes back `unavailable` while the user actually answered the
 * prompt, the observer changed behavior and that is a decisive negative.
 *
 * Privacy: shapes, ids and counts only. Question text, option labels, plan
 * markdown, approval reasons and answer content are never written — the probe
 * measures field *presence and length*, never content. Output goes to stderr
 * and is appended to `~/.dsh/probe-interactions.log`, because terminal
 * scrollback is easy to lose (PL-PR-IV-01's post-mortem) and the log path is
 * outside the repository on purpose.
 *
 * @module dsh-petseen-probe
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Name this probe is inserted under in the profile's loader tree. */
export const name = 'dsh-petseen-probe'

/**
 * Declared services.
 *
 * Empty on purpose: the probe listens to events and reads no service. Declaring
 * one would make the loader wait for it and would turn a missing service into
 * "the probe never armed" instead of a readable line.
 */
export const inject = []

/** Where the readings survive a lost terminal. */
const LOG_PATH = join(homedir(), '.dsh', 'probe-interactions.log')

/** Prefix every line with it; the runbook greps for exactly this. */
const MARK = 'dsh-petseen-probe'

/** The two blocking waits, as the host dispatches them (waterfall events). */
const WATERFALLS = ['approval/request', 'user-questions/request']

/** Session-event types read field by field; every other type is noted once. */
const AUDIT_TYPES = ['approval/asked', 'approval/decided']

/**
 * Tool names worth a line on every call.
 *
 * Deliberately a loose pattern, not a list: the point of the probe is to learn
 * the *actual* name DSH uses for the question tool, so hardcoding a guess would
 * defeat it. Every other name is still reported on first sighting.
 */
const INTERESTING_TOOL_RE = /ask|question|plan/i

/** Run the thunk, or return `undefined`; a probe never throws into the host. */
function safe(run) {
  try {
    return run()
  } catch {
    return undefined
  }
}

/** One line, to stderr and to the log file; never throws. */
function emit(marker, detail = '') {
  const line = `${MARK} ${marker}${detail === '' ? '' : ` ${detail}`}`
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    /* stderr closed: the file below is the fallback */
  }
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* no writable home: stderr above is the fallback */
  }
}

/** `present(len=N)` / `absent` / `present(len=?)` for an opaque value. */
function shape(value) {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (typeof value === 'string') return `present(len=${value.length})`
  if (Array.isArray(value)) return `present(items=${value.length})`
  return `present(type=${typeof value})`
}

/** A string field as `key=value`, or `key=absent`. */
function text(key, value) {
  return typeof value === 'string' && value !== '' ? `${key}=${value}` : `${key}=absent`
}

/**
 * The session this request belongs to, from whichever shape carries it.
 *
 * `approval/request` declares `agent` as required and `user-questions/request`
 * declares it optional, so "absent" is a possible — and decisive — reading for
 * the question side: without it the host cannot attribute the wait to a session
 * and the design has to fall back to the browser-side map.
 */
function agentFields(payload) {
  const agent = safe(() => payload?.agent)
  if (agent === undefined || agent === null) return 'agent=absent'
  const id = safe(() => agent.id)
  const sessionId = safe(() => agent.session?.id)
  return `${text('agentId', id)} ${text('agentSessionId', sessionId)}`
}

/** Approval payload, by shape only. */
function describeApproval(request) {
  const signal = safe(() => request?.signal)
  return [
    agentFields(request),
    text('toolName', safe(() => request?.toolName)),
    `callId=${shape(safe(() => request?.callId))}`,
    `reason=${shape(safe(() => request?.reason))}`,
    `signal=${signal === undefined ? 'absent' : `present(aborted=${String(safe(() => signal.aborted) ?? '?')})`}`,
  ].join(' ')
}

/** Question payload, by shape only — never the question text. */
function describeQuestions(request) {
  const questions = safe(() => request?.questions)
  const list = Array.isArray(questions) ? questions : []
  const perQuestion = list.map((item, index) => {
    const options = safe(() => item?.options)
    const optionCount = Array.isArray(options) ? options.length : 0
    const intent = safe(() => item?.intent?.kind)
    return [
      `q${index}{`,
      text('id', safe(() => item?.id)),
      `options=${optionCount}`,
      `multiSelect=${String(safe(() => item?.multiSelect) ?? false)}`,
      `detail=${shape(safe(() => item?.detail))}`,
      `header=${shape(safe(() => item?.header))}`,
      `intent=${typeof intent === 'string' && intent !== '' ? intent : 'none'}`,
      `approve=${shape(safe(() => item?.intent?.approve))}`,
      '}',
    ].join(' ')
  })
  const signal = safe(() => request?.signal)
  return [
    agentFields(request),
    `questions=${list.length}`,
    `signal=${signal === undefined ? 'absent' : `present(aborted=${String(safe(() => signal.aborted) ?? '?')})`}`,
    ...perQuestion,
  ].join(' ')
}

/** An error as its closed taxonomy only (`name` / `code`), never its message. */
function errorFields(error) {
  const errorName = safe(() => error?.name)
  const errorCode = safe(() => error?.code)
  return `errorName=${typeof errorName === 'string' ? errorName : typeof error} errorCode=${
    typeof errorCode === 'string' ? errorCode : 'absent'
  }`
}

/** Settlement summary, by class — never a label or a typed answer. */
function describeSettlement(which, outcome) {
  if (which === 'approval/request') {
    return `outcome=${typeof outcome === 'string' ? outcome : `non-string(${typeof outcome})`}`
  }
  const answers = safe(() => outcome?.answers)
  const list = Array.isArray(answers) ? answers : []
  const selected = list.reduce((sum, item) => {
    const picked = safe(() => item?.selected)
    return sum + (Array.isArray(picked) ? picked.length : 0)
  }, 0)
  const custom = list.filter((item) => safe(() => typeof item?.custom === 'string' && item.custom !== '') === true).length
  return `answers=${list.length} selectedTotal=${selected} custom=${custom}`
}

/** How many times each waterfall fired, for the ask line's running count. */
const counters = { 'approval/request': 0, 'user-questions/request': 0 }

/** Every `session/event` type seen, so the live vocabulary is readable. */
const seenTypes = new Set()

/** Tool name → call count. */
const toolCalls = new Map()

/**
 * Wrap one waterfall so the request, the wait and the outcome are all recorded.
 *
 * The listener is in the answerer chain, so the passthrough has to be exact:
 * the downstream value is returned and the downstream rejection re-thrown. The
 * only addition is a settle line, and every line is written through `safe()`
 * paths that cannot throw.
 */
function observeWaterfall(ctx, event) {
  ctx.on(event, (payload, next) => {
    const at = Date.now()
    counters[event] += 1
    const ticket = `n=${counters[event]} ${
      event === 'approval/request' ? describeApproval(payload) : describeQuestions(payload)
    }`
    emit(`${event}.asked`, ticket)
    let downstream
    try {
      downstream = next()
    } catch (error) {
      emit(`${event}.settled`, `${ticket} ms=${Date.now() - at} how=sync-throw ${errorFields(error)}`)
      throw error
    }
    if (downstream === null || downstream === undefined || typeof downstream.then !== 'function') {
      emit(`${event}.settled`, `${ticket} ms=${Date.now() - at} how=non-promise`)
      return downstream
    }
    return downstream.then(
      (outcome) => {
        emit(`${event}.settled`, `${ticket} ms=${Date.now() - at} how=return ${describeSettlement(event, outcome)}`)
        return outcome
      },
      (error) => {
        emit(`${event}.settled`, `${ticket} ms=${Date.now() - at} how=reject ${errorFields(error)}`)
        throw error
      },
    )
  })
}

/**
 * The session-side cross-check.
 *
 * `approval/asked` is the durable audit half of a request (the UI is driven by
 * the waterfall), so seeing the audit *without* the waterfall means this
 * listener was not the first in the chain — or was not in it at all.
 */
function observeSessionEvents(ctx) {
  ctx.on('session/event', (session, event) => {
    const sessionId = safe(() => String(session?.id)) ?? '?'
    const type = safe(() => String(event?.type)) ?? '?'
    if (!seenTypes.has(type)) {
      seenTypes.add(type)
      emit('session-event.new', `type=${type} sessionId=${sessionId}`)
    }
    if (AUDIT_TYPES.includes(type)) {
      const data = safe(() => event?.data)
      emit(
        `session-event.${type}`,
        `sessionId=${sessionId} ${text('id', safe(() => data?.id))} ${text('toolName', safe(() => data?.toolName))} ${
          text('outcome', safe(() => data?.outcome))
        } callId=${shape(safe(() => data?.callId))} reason=${shape(safe(() => data?.reason))}`,
      )
      return
    }
    if (type !== 'tool/call') return
    const toolName = safe(() => event?.data?.name)
    if (typeof toolName !== 'string' || toolName === '') return
    const count = (toolCalls.get(toolName) ?? 0) + 1
    toolCalls.set(toolName, count)
    if (count === 1 || INTERESTING_TOOL_RE.test(toolName)) {
      emit('session-event.tool-call', `sessionId=${sessionId} name=${toolName} n=${count}`)
    }
  })
}

/**
 * Mount the probe.
 *
 * @param ctx - the host root context the loader hands to every plugin.
 */
export function apply(ctx) {
  const on = safe(() => ctx?.on)
  emit('armed', `pid=${process.pid} node=${process.version} log=${LOG_PATH} waterfall=[${WATERFALLS.join(',')}] sessionEvents=[session/event]`)
  if (typeof on !== 'function') {
    emit('disarmed', 'ctx.on is not a function: nothing was registered')
    return
  }
  for (const event of WATERFALLS) safe(() => observeWaterfall(ctx, event))
  safe(() => observeSessionEvents(ctx))
  emit('ready', `waterfalls=${WATERFALLS.length} + session-event listener`)
}
