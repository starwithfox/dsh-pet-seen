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
 *     readers of the drift self-check (PL-EN-NW-06); `probe-http.mjs` is
 *     the other, and it is the one that turns drift into a failing exit code.
 *     These rows are *live* — each expires with its tab's lease, and the page
 *     renews that lease only while it is visible and focused — so unlike
 *     `reader` on the session lines they can legitimately be absent, and their
 *     absence is printed rather than silently omitted.
 *
 *     A row that exists but carries **no `reader` field** is a different thing
 *     and is marked `STALE`: the tab is alive enough to hold a lease, yet its
 *     client half never reported the self-check, so it predates that field
 *     (PL-EN-NW-06) — a stale install or an unbuilt bundle, the mixture
 *     PL-OP-FX-01 is about. `DRIFT` is the
 *     other non-zero reading: sessions are visible but none is named.
 *
 *   - the **build handshake** added by PL-EN-NW-02: the host states which build it
 *     is (`pluginVersion` / `buildId` on the header line) and every tab states
 *     which build its client half is (per-row `build`). A row whose id differs
 *     from the host's is marked `MIXED`, and one that carries no id at all is
 *     marked `OLD`. Both mean the two halves did not come from one build — the
 *     state that used to be indistinguishable from a healthy install while the
 *     drift self-check (PL-EN-NW-06) was silently dead. As with
 *     `STALE`/`DRIFT`, this tool only reports; `probe-http.mjs` is the one that
 *     turns any of them into a failing exit code.
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
    + ` petPort=${state.petPort ?? '-'} notices=${notices.length}`
    + ` plugin=${state.pluginVersion ?? '-'} build=${state.buildId ?? '-'}`,
  )
  for (const session of state.sessions ?? []) {
    console.log(`session ${short(session.sessionId)} running=${String(session.running)} title="${session.title ?? ''}"`
      + `${session.reader === undefined ? '' : ` reader=${session.reader}`}`)
  }
  const tabs = Array.isArray(state.browserTabs) ? state.browserTabs : []
  if (tabs.length === 0) {
    /*
     * Say so instead of printing nothing: a silent absence was indistinguishable
     * from "the host half is still the previous build" (which also served no
     * `browserTabs`). This list is live — a row expires with its tab's lease,
     * and the page renews that only while visible and focused — whereas `reader`
     * on the session lines above is written into the session fact and persists.
     */
    console.log('(no live tab diagnostic: nothing has reported yet, or the last report aged out of the'
      + ' lease TTL — the page renews it only while visible and focused)')
  }
  const hostBuild = typeof state.buildId === 'string' && state.buildId !== '' ? state.buildId : null
  for (const tab of tabs) {
    const noBuild = typeof tab.buildId !== 'string' || tab.buildId === ''
    console.log(`tab ${short(tab.tabId)} reader=${tab.reader ?? '-'} (${tab.readerReason ?? '-'})`
      + ` byId=${tab.byIdCount ?? '-'} session=${short(tab.sessionId)} build=${noBuild ? '-' : tab.buildId}`
      + (noBuild ? '  <-- OLD: no build id (client half predates the handshake)' : '')
      + (!noBuild && hostBuild !== null && tab.buildId !== hostBuild
        ? `  <-- MIXED: client build ${tab.buildId} != host build ${hostBuild}` : '')
      + (typeof tab.reader !== 'number' ? '  <-- STALE: client half predates the self-check (no reader field)' : '')
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
