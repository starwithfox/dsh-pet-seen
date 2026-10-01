#!/usr/bin/env node
/**
 * Token-free view of the bridge's `/state`, for pet-side acceptance.
 *
 * `probe-http.mjs` answers "is the plane healthy?"; this answers "what does the
 * host currently think about my pet and my notices?" — the two facts a desktop
 * pet has to agree with:
 *
 *   - `petPort` — did the pet handshake and get adopted?
 *   - every retained notice, with its short id, turn, state and delivery flag,
 *     so `shown` -> `dismissed` / `seen` transitions can be quoted as evidence
 *     without ever printing the token.
 *   - every browser tab's session-read diagnostic, so "which of the four reads
 *     named the session" can be quoted the same way. This is one of the two
 *     readers of the drift self-check (`FIX-DESIGN` §5.5); `probe-http.mjs` is
 *     the other, and it is the one that turns drift into a failing exit code.
 *
 * Read-only. Exits 1 when `/state` cannot be read.
 *
 * USAGE
 *   node tools/bridge-state.mjs            (credentials from ~/.dsh/pet-bridge.json)
 *   DSH_PET_BRIDGE_FILE=... node tools/bridge-state.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Eight characters are enough to match a notice against a report. */
const short = (value) => {
  const text = String(value ?? '-').replace(/^session-/, '')
  return text.length > 8 ? text.slice(0, 8) : text
}

const file = process.env.DSH_PET_BRIDGE_FILE ?? join(homedir(), '.dsh', 'pet-bridge.json')

let bridge
let state = null
let status = 0
try {
  bridge = JSON.parse(readFileSync(file, 'utf8'))
  const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${bridge.token}`)
  status = response.status
  state = await response.json()
} catch (error) {
  console.log(`could not read /state: ${String(error)}`)
  process.exitCode = 1
}

if (state !== null) {
  const notices = Array.isArray(state.notices) ? state.notices : []
  console.log(
    `controlPort=${bridge.controlPort} status=${status} revision=${state.revision}`
    + ` petPort=${state.petPort ?? '-'} notices=${notices.length}`,
  )
  for (const session of state.sessions ?? []) {
    console.log(`session ${short(session.sessionId)} running=${String(session.running)} title="${session.title ?? ''}"`
      + `${session.reader === undefined ? '' : ` reader=${session.reader}`}`)
  }
  const tabs = Array.isArray(state.browserTabs) ? state.browserTabs : []
  for (const tab of tabs) {
    console.log(`tab ${short(tab.tabId)} reader=${tab.reader ?? '-'} (${tab.readerReason ?? '-'})`
      + ` byId=${tab.byIdCount ?? '-'} session=${short(tab.sessionId)}`
      + (tab.reader === -1 && (tab.byIdCount ?? 0) > 0 ? '  <-- DRIFT: sessions visible, none named' : ''))
  }
  for (const notice of notices) {
    console.log(
      `notice ${short(notice.noticeId)} turn=${String(notice.targetTurnRef)} state=${String(notice.state)}`
      + ` delivered=${String(notice.delivered)} seenAt=${notice.seenAt === null || notice.seenAt === undefined ? '-' : new Date(notice.seenAt).toISOString()}`
      + ` session=${short(notice.sessionId)}`,
    )
  }
}
