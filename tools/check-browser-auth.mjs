#!/usr/bin/env node
/**
 * Offline check that the acceptance driver can authenticate to DSH's web server.
 *
 * The driver needs a browser-session cookie before it can navigate a headless
 * browser to `http://127.0.0.1:3080/`; without one, `/` answers 401. Minting
 * that cookie is the one part of the run that can be verified *without* starting
 * a browser — and starting a browser costs a sandbox escalation — so it is
 * checked here first.
 *
 * It performs three requests against the page origin:
 *   1. no cookie            -> expected 401 (proves the server really is gated);
 *   2. the minted cookie    -> expected 200 (proves the minting is correct);
 *   3. a tampered cookie    -> expected 401 (proves the check is not vacuous).
 *
 * USAGE
 *   node tools/check-browser-auth.mjs [--url http://127.0.0.1:3080/] [--json]
 *
 * EXIT CODES
 *   0  the minted cookie is accepted and the negated check is refused
 *   1  the minted cookie was refused, or a vacuous probe passed
 *   2  the server could not be reached at all
 *
 * @module tools/check-browser-auth
 */

import { buildSessionCookie, readSessionSecret, splitCookie } from './browser-auth.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const PAGE_URL = flag('url', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080/')
const AS_JSON = argv.includes('--json')

/** One GET of the page root, optionally with a cookie. */
async function probe(cookie) {
  const response = await fetch(PAGE_URL, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  })
  const body = await response.text()
  return { status: response.status, authenticated: response.status === 200, note: body.trim().slice(0, 80) }
}

const issuedAt = Date.now()

/**
 * Run the three probes.
 *
 * Kept in a function so every exit path sets `process.exitCode` instead of
 * calling `process.exit()`: Node on Windows aborts with a libuv assertion
 * (`async.c: 94`) when the process is torn down while `fetch` handles are still
 * closing, which would replace the verdict with a crash code.
 *
 * @returns the process exit code.
 */
async function main() {
  let cookie
  try {
    cookie = buildSessionCookie({
      pageUrl: PAGE_URL,
      secret: readSessionSecret(),
      issuedAt,
      expiresAt: issuedAt + 24 * 60 * 60 * 1000,
    })
  } catch (error) {
    console.error(`[auth-check] cannot mint a cookie: ${String(error && error.message ? error.message : error)}`)
    return 1
  }

  const { name, value } = splitCookie(cookie)
  let anonymous
  let minted
  let tampered
  try {
    anonymous = await probe(null)
    minted = await probe(cookie)
    // Flip one character of the signature: the payload stays valid, so a server
    // that accepted this would not be checking the signature at all.
    tampered = await probe(`${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`)
  } catch (error) {
    console.error(`[auth-check] ${PAGE_URL} is unreachable: ${String(error && error.message ? error.message : error)}`)
    return 2
  }

  const verdict = anonymous.status === 401 && minted.authenticated && tampered.status === 401 ? 'PASS' : 'FAIL'
  if (AS_JSON) {
    console.log(JSON.stringify({ verdict, pageUrl: PAGE_URL, cookieName: name, anonymous, minted, tampered }, null, 2))
  } else {
    console.log(`[auth-check] ${PAGE_URL}`)
    console.log(`  cookie name          ${name}`)
    console.log(`  no cookie            HTTP ${anonymous.status}${anonymous.status === 401 ? ' (gated, as expected)' : ' <- the server is NOT gated; this probe proves nothing'}`)
    console.log(`  minted cookie        HTTP ${minted.status}${minted.authenticated ? ' (accepted)' : ` <-- REFUSED: ${minted.note}`}`)
    console.log(`  tampered signature   HTTP ${tampered.status}${tampered.status === 401 ? ' (refused, as expected)' : ' <- a bad signature was accepted!'}`)
    console.log(`  VERDICT: ${verdict}`)
  }
  return verdict === 'PASS' ? 0 : 1
}

process.exitCode = await main()
