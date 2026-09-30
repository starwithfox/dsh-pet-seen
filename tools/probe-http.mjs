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
 *      read, and the `/state` snapshot behind it.
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
 *   node tools/probe-http.mjs [baseUrl] [--web-only]   (default http://127.0.0.1:3080)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSessionCookie, readSessionSecret, resolvePetClientUrl, splitCookie } from './browser-auth.mjs'

const args = process.argv.slice(2)
const WEB_ONLY = args.includes('--web-only')
const BASE = args.find((value) => !value.startsWith('--')) ?? 'http://127.0.0.1:3080'
const now = Date.now()
let failures = 0

const cookie = buildSessionCookie({
  pageUrl: `${BASE}/`,
  secret: readSessionSecret(),
  issuedAt: now,
  expiresAt: now + 24 * 60 * 60 * 1000,
})
console.log(`[probe] cookie ${splitCookie(cookie).name}`)

/** Fetch one path, reporting status/size, and print a short body excerpt. */
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
    console.log(`${String(response.status).padEnd(4)} ${String(text.length).padStart(8)}  ${label}`)
    if (excerpt > 0) console.log(text.slice(0, excerpt).replaceAll('\n', '\n      '))
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    failures += 1
    console.log(`ERR  ${' '.repeat(8)}  ${label}  ${String(error)}`)
    return { ok: false, status: 0, text: '' }
  }
}

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

console.log('\n=== gate: the control plane the pet (and the driver) reads credentials from ===')
if (WEB_ONLY) {
  console.log('  skipped (--web-only): this run says nothing about the control plane')
} else {
  let problem = null
  try {
    const bridge = JSON.parse(readFileSync(join(homedir(), '.dsh', 'pet-bridge.json'), 'utf8'))
    const response = await fetch(`http://127.0.0.1:${bridge.controlPort}/state?token=${bridge.token}`)
    const text = await response.text()
    let state = null
    try { state = JSON.parse(text) } catch { state = null }
    console.log(`controlPort=${bridge.controlPort} status=${response.status}`
      + ` revision=${state?.revision ?? '-'} petPort=${state?.petPort ?? '-'}`
      + ` writtenAt=${bridge.writtenAt ?? '-'}`)
    for (const session of state?.sessions ?? []) {
      console.log(`  ${session.sessionId}  running=${session.running}  title="${session.title ?? ''}"`)
    }
    if ((state?.sessions ?? []).length === 0) {
      console.log('  (no sessions — a notice can never be minted for this run)')
    }
    if (response.status === 401) {
      problem = `HTTP 401: the file's token is not the live one, so ${'~/.dsh/pet-bridge.json'} is stale`
        + ' — restart DSH to republish it (the token is never printed and cannot be recovered)'
    } else if (!response.ok) {
      problem = `HTTP ${response.status}`
    } else if (state === null || typeof state.revision !== 'number') {
      problem = 'the response body is not a /state snapshot (no numeric `revision`)'
    }
  } catch (error) {
    problem = `${String(error)} — is the file readable and the control listener up?`
  }
  if (problem !== null) {
    failures += 1
    console.log(`  !! control plane unhealthy: ${problem}`)
  }
}

const scope = WEB_ONLY ? 'web assets only; control plane NOT checked' : 'web assets + control plane'
console.log(`\nVERDICT: ${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`} (${scope})`)
process.exitCode = failures === 0 ? 0 : 1
