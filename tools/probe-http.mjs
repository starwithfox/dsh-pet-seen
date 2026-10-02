#!/usr/bin/env node
/**
 * Offline web-layer probe for the CDP acceptance driver.
 *
 * `tools/check-browser-auth.mjs` proves the minted cookie is *accepted*. This
 * goes one layer further and answers "is the web layer healthy at all?" without
 * launching a browser — which matters because a Chrome run costs a
 * `danger-full-access` approval the user has to be present to grant.
 *
 * It was written during ROUND 4 to attribute a driver failure: the driver
 * reported "the page never rendered a conversation flow with a live pet client"
 * and nothing else, so it was not clear whether the server, an asset, or the
 * page boot was at fault. All three are checked here:
 *
 *   1. `GET /` with and without the cookie (expect 401 / 200 app shell).
 *   2. every script/link the shell references, plus the pet plugin's own client
 *      bundle from the boot payload (a 404 here is indistinguishable from "the
 *      app never booted" when seen from inside the driver).
 *   3. the host's control plane: the credential file the pet and the CDP driver
 *      read, the `/state` snapshot behind it, and the per-tab session-read
 *      diagnostics that snapshot carries (`browserTabs`). Those diagnostics are
 *      the drift self-check of `FIX-DESIGN` §5.5, and this probe is one of the
 *      two readers that are supposed to notice.
 *
 * Three readings come out of `browserTabs`, and they mean different things:
 *
 *   - a tab row with **no `reader` field** ⇒ **FAIL**. A tab row is a live
 *     lease, so the page did report; every client half since step 5 sends
 *     `reader` (a `-1` is a *report*, not an omission), and a report that
 *     carries no diagnostics leaves the previous value in place rather than
 *     clearing it. So a row that has never had one means that tab's client half
 *     predates the self-check — a stale install or an unbuilt bundle. That state
 *     used to pass silently, which made "there is no drift" and "this build
 *     cannot see drift" the same output (step 5.1).
 *   - `reader === -1` with sessions present ⇒ **FAIL**: the client session read
 *     has drifted and notice retraction is blind until it is fixed.
 *   - `reader > 0` ⇒ a warning, not a failure: a fallback read answered. The
 *     chain is *designed* to degrade, and this is the earliest signal that the
 *     preferred read is gone.
 *
 * `browserTabs` is a *live* channel — a row expires with its tab's lease — so
 * the durable reading is `sessions[].reader`, and an empty `browserTabs` is
 * reported as the ambiguity it is rather than as "nothing has reported yet".
 *
 * Sizes are printed as **bytes** (`Buffer.byteLength`). Until 2026-10-02 this
 * column was `text.length`, i.e. UTF-16 code units: the served pet bundle
 * measured 45,579 there while it was 45,649 bytes, which invited an arithmetic
 * that meant nothing — the WebServer appends a `sourceMappingURL` comment, so
 * served bytes never equal artifact bytes and must not be compared at all
 * (compare *content markers* instead).
 *
 * Read-only: it starts nothing and changes nothing. Exit code is 1 when any
 * fetched asset failed **or** the control plane is unhealthy, so it can be used
 * as a check rather than only as a read.
 *
 * Why the control plane is a gate and not a footnote: a stale
 * `~/.dsh/pet-bridge.json` (random port, dead token) leaves the web layer
 * perfectly green while every pet, mock pet and driver that reads that file
 * fails — and an earlier version of this probe printed `VERDICT: PASS` in
 * exactly that state, which made the failure look like "DSH is down". Pass
 * `--web-only` when you genuinely only care about assets; the verdict line then
 * says so.
 *
 * USAGE
 *   node tools/probe-http.mjs [baseUrl] [--web-only] [--state-json <file>]
 *                              (default http://127.0.0.1:3080)
 *
 * `--state-json <file>` judges a `/state` snapshot read from a file instead of
 * the live control plane, and skips the web gates entirely. It exists so the
 * verdict itself can be proved red **and** green against fixtures
 * (`tools/fixtures/probe-state-*.json`) without a host, a cookie or a browser —
 * the same "prove the check bites" discipline the tests use.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSessionCookie, readSessionSecret, resolvePetClientUrl, splitCookie } from './browser-auth.mjs'

const args = process.argv.slice(2)
const WEB_ONLY = args.includes('--web-only')
const flagValue = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const STATE_JSON = flagValue('--state-json')
const BASE = args.find((value) => !value.startsWith('--') && value !== STATE_JSON) ?? 'http://127.0.0.1:3080'
const now = Date.now()
let failures = 0

/** Enough of an opaque id to match it between two lines of output. */
const shortId = (value) => {
  // Strip the `session-` prefix first: without it every session id shortens to
  // the useless literal `session-`, and the tab's `session=` can no longer be
  // matched against the session lines above it. `bridge-state.mjs` agrees.
  const text = String(value ?? '-').replace(/^session-/, '')
  return text.length > 8 ? text.slice(0, 8) : text
}

/** Fetch one path, reporting status/size in bytes, and print a short excerpt. */
async function fetchPath(label, path, { headers = {}, excerpt = 0 } = {}) {
  // The shell mixes absolute and `./`-relative references, so resolve rather
  // than concatenate (concatenation produced `http://host./assets/...`).
  let url
  try {
    url = new URL(path, `${BASE}/`).href
  } catch (error) {
    failures += 1
    console.log(`ERR  ${' '.repeat(8)}  ${label}  unresolvable URL: ${String(error)}`)
    return { ok: false, status: 0, text: '' }
  }
  try {
    const response = await fetch(url, { headers, redirect: 'manual' })
    const text = await response.text()
    console.log(`${String(response.status).padEnd(4)} ${String(Buffer.byteLength(text)).padStart(8)}  ${label}`)
    if (excerpt > 0) console.log(text.slice(0, excerpt).replaceAll('\n', '\n      '))
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    failures += 1
    console.log(`ERR  ${' '.repeat(8)}  ${label}  ${String(error)}`)
    return { ok: false, status: 0, text: '' }
  }
}

/**
 * Print one `/state` snapshot and say whether it is healthy.
 *
 * Split out of the gate below so the same judgement runs against the live host
 * and against a `--state-json` fixture; printing and verdict must not be able to
 * disagree, which is why they live in one function.
 *
 * @param state - parsed `/state` body, or null when the body was not JSON.
 * @param status - HTTP status that carried it (200 for a fixture).
 * @param origin - `controlPort` / `writtenAt` for the header line.
 * @returns the failure reason, or null when the snapshot is healthy.
 */
function reportState(state, status, origin) {
  console.log(`controlPort=${origin.controlPort} status=${status} revision=${state?.revision ?? '-'}`
    + ` petPort=${state?.petPort ?? '-'} writtenAt=${origin.writtenAt ?? '-'}`)
  for (const session of state?.sessions ?? []) {
    console.log(`  ${session.sessionId}  running=${session.running}  title="${session.title ?? ''}"`
      + `${session.reader === undefined ? '' : `  reader=${session.reader}`}`)
  }
  if ((state?.sessions ?? []).length === 0) {
    console.log('  (no sessions — a notice can never be minted for this run)')
  }

  const tabs = Array.isArray(state?.browserTabs) ? state.browserTabs : []
  if (tabs.length === 0) {
    /*
     * Emptiness here is ambiguous, and reporting it as one specific thing was
     * a real misread: this list is a *live* channel. The host drops a row once
     * the tab's lease ages out (`DEFAULT_LEASE_TTL_MS`), and the client
     * renews that lease only while the page is visible **and** focused — so
     * "nothing here" is either "nothing has reported yet" or "the page lost
     * focus more than the lease window ago". It is deliberately not a
     * failure: the durable reading is `sessions[].reader`, printed above.
     */
    console.log('  (no live tab diagnostic: nothing has reported yet, OR the last report aged out of the'
      + ' host lease TTL — the page renews it only while visible and focused, so re-run with the app window'
      + ' focused. Judge `reader` by the session lines above, which persist.)')
  }
  for (const tab of tabs) {
    const absence = typeof tab.reader !== 'number'
    console.log(`  tab ${shortId(tab.tabId)} reader=${tab.reader ?? '-'} (${tab.readerReason ?? '-'})`
      + ` byId=${tab.byIdCount ?? '-'} session="${shortId(tab.sessionId)}"`
      + (absence ? '  !! no self-check field: this tab\'s client half predates step 5' : ''))
  }
  const degraded = tabs.filter((tab) => typeof tab.reader === 'number' && tab.reader > 0)
  if (degraded.length > 0) {
    console.log(`  !! ${degraded.length} tab(s) answered from a fallback read (reader=${degraded[0].reader}`
      + ` = ${degraded[0].readerReason ?? '?'}, not 0): earliest drift signal — not a failure on its own`)
  }

  if (status === 401) {
    return `HTTP 401: the file's token is not the live one, so ${'~/.dsh/pet-bridge.json'} is stale`
      + ' — restart DSH to republish it (the token is never printed and cannot be recovered)'
  }
  if (status < 200 || status >= 300) return `HTTP ${status}`
  if (state === null || typeof state?.revision !== 'number') {
    return 'the response body is not a /state snapshot (no numeric `revision`)'
  }
  const withoutSelfCheck = tabs.filter((tab) => typeof tab.reader !== 'number')
  if (withoutSelfCheck.length > 0) {
    return `${withoutSelfCheck.length} browser tab(s) hold a live lease but report no \`reader\`: that tab's`
      + ' client half is older than the drift self-check, so "no drift" and "cannot see drift" are the same'
      + ' output here — reinstall/rebuild the plugin and restart the host (step 5.1)'
  }
  const blind = tabs.filter((tab) => tab.reader === -1 && (tab.byIdCount ?? 0) > 0)
  if (blind.length > 0) {
    return `${blind.length} browser tab(s) can see sessions (byId=${blind[0].byIdCount}) but none of the`
      + ' four reads names the current one: the client session read has drifted, and notice retraction'
      + ' is blind until it is fixed (see FIX-DESIGN §5.5)'
  }
  return null
}

if (STATE_JSON === undefined) {
  const cookie = buildSessionCookie({
    pageUrl: `${BASE}/`,
    secret: readSessionSecret(),
    issuedAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  })
  console.log(`[probe] cookie ${splitCookie(cookie).name}`)

  console.log('\n=== gate: the app shell needs the cookie, and accepts ours ===')
  const anonymous = await fetchPath('GET / (no cookie)', '/', { excerpt: 90 })
  const authenticated = await fetchPath('GET / (minted cookie)', '/', { headers: { cookie } })
  if (anonymous.status !== 401) {
    failures += 1
    console.log(`  !! expected 401 without a cookie, got ${anonymous.status}`)
  }
  if (!authenticated.ok) {
    failures += 1
    console.log('  !! the app shell is not being served; nothing below can work')
  }

  const html = authenticated.text

  console.log('\n=== gate: every asset the shell references resolves ===')
  const referenced = [...new Set([
    ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((match) => match[1]),
  ].map((value) => value.replaceAll('&amp;', '&')))]
  for (const asset of referenced) {
    const result = await fetchPath(asset, asset, { headers: { cookie } })
    if (!result.ok) failures += 1
  }

  console.log('\n=== gate: the pet plugin client bundle the boot payload names ===')
  // Which URL serves the bundle, and why the boot JSON entry is the authority rather than the
  // shared `<script src>` group, lives in `resolvePetClientUrl` (tools/browser-auth.mjs).
  const clientPath = resolvePetClientUrl(html, referenced)
  if (clientPath === undefined) {
    failures += 1
    console.log('  !! dsh-pet-bridge is not in the boot payload: the plugin is not loaded for this profile')
  } else {
    const result = await fetchPath(`dsh-pet-bridge/client.js (${clientPath})`, clientPath, { headers: { cookie } })
    if (!result.ok) failures += 1
  }
}

console.log('\n=== gate: the control plane the pet (and the driver) reads credentials from ===')
if (WEB_ONLY) {
  console.log('  skipped (--web-only): this run says nothing about the control plane')
} else {
  let problem = null
  if (STATE_JSON !== undefined) {
    try {
      const text = readFileSync(STATE_JSON, 'utf8')
      let state = null
      try { state = JSON.parse(text) } catch { state = null }
      problem = reportState(state, 200, { controlPort: `fixture:${STATE_JSON}`, writtenAt: '-' })
    } catch (error) {
      problem = `cannot read ${STATE_JSON}: ${String(error)}`
    }
  } else {
    try {
      const bridge = JSON.parse(readFileSync(join(homedir(), '.dsh', 'pet-bridge.json'), 'utf8'))
      const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${bridge.token}`)
      const text = await response.text()
      let state = null
      try { state = JSON.parse(text) } catch { state = null }
      problem = reportState(state, response.status, { controlPort: bridge.controlPort, writtenAt: bridge.writtenAt })
    } catch (error) {
      problem = `${String(error)} — is the file readable and the control listener up?`
    }
  }
  if (problem !== null) {
    failures += 1
    console.log(`  !! control plane unhealthy: ${problem}`)
  }
}

const scope = STATE_JSON !== undefined
  ? 'fixture snapshot only; web assets NOT checked'
  : WEB_ONLY
    ? 'web assets only; control plane NOT checked'
    : 'web assets + control plane'
console.log(`\nVERDICT: ${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`} (${scope})`)
process.exitCode = failures === 0 ? 0 : 1
