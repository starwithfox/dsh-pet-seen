/**
 * Browser-session cookie minting for the headless acceptance driver.
 *
 * DSH's web server refuses `/` and every API request without a signed,
 * authority-bound browser-session cookie (`dsh-client-connection`'s
 * `BrowserAuth`). The cookie is normally minted by a one-time exchange of the
 * process launch token — a value that only ever exists in the server's memory,
 * so a headless browser with a fresh profile has no way to obtain it.
 *
 * The signing secret, however, is a durable credential DSH stores for this
 * machine (`$DSH_HOME/.credentials.yaml`, record
 * `client-connection/browser-session`). Recomputing the cookie from it grants
 * no new access: it is the same credential the user's own browser already
 * carries, bound to the same host and port. This module is the whole of that
 * computation, kept separate so it can be verified without launching a browser
 * (see `tools/check-browser-auth.mjs`).
 *
 * The format is fixed by the server: `v1.<base64url payload>.<base64url HMAC>`
 * over the base64url payload, with a cookie name derived from the authority.
 *
 * @module tools/browser-auth
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cookie payload version the server accepts. */
const COOKIE_PAYLOAD_VERSION = 1
/** Prefix of the server's cookie name. */
const COOKIE_PREFIX = 'dsh-auth-'

/** base64url without padding, as the server encodes it. */
export function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** Decode unpadded base64url. */
export function unb64url(text) {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/** Where the credential store lives. */
export function credentialsPath(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(dshHome, '.credentials.yaml')
}

/**
 * Read the browser-session signing secret out of the credential store.
 *
 * Deliberately a targeted scan rather than a YAML parse: this file is a
 * two-level map of records, the record name is unique, and pulling in a YAML
 * dependency for one line would put a runtime dependency in an acceptance tool.
 *
 * @param dshHome - harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the base64url secret string.
 * @throws when the file or the record is missing.
 */
export function readSessionSecret(dshHome) {
  const path = credentialsPath(dshHome)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${String(error && error.message ? error.message : error)}`)
  }
  const match = /client-connection\/browser-session:[\s\S]*?\n\s*secret:\s*(\S+)/.exec(text)
  if (match === null) {
    throw new Error(`no client-connection/browser-session secret in ${path}`)
  }
  return match[1]
}

/**
 * Build the cookie the server would accept for one page origin.
 *
 * @param options.pageUrl - page URL whose authority the cookie is bound to.
 * @param options.secret - base64url signing secret.
 * @param options.issuedAt - epoch ms the payload claims to have been issued.
 * @param options.expiresAt - epoch ms the payload expires; the server rejects an
 *   interval longer than its configured `cookieMaxAgeDays`.
 * @returns a `name=value` cookie header pair.
 */
export function buildSessionCookie({ pageUrl, secret, issuedAt, expiresAt }) {
  const authority = new URL(pageUrl).host
  const key = unb64url(secret)
  if (key.byteLength !== 32) {
    throw new Error(`the stored signing secret is ${key.byteLength} bytes, expected 32`)
  }
  const body = b64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'))
  const signature = b64url(createHmac('sha256', key).update(body).digest())
  const name = `${COOKIE_PREFIX}${b64url(createHash('sha256').update(authority).digest())}`
  return `${name}=v1.${body}.${signature}`
}

/**
 * Split a `name=value` cookie pair.
 *
 * @param cookie - the assembled cookie.
 * @returns its name and value.
 */
export function splitCookie(cookie) {
  const separator = cookie.indexOf('=')
  if (separator <= 0) throw new Error(`not a cookie pair: ${cookie.slice(0, 40)}`)
  return { name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }
}

/**
 * Resolve the URL that serves the pet plugin's own client bundle, from an app shell.
 *
 * Two shapes in the shell carry the plugin roster, and on the 0.2.0-rc.2 desktop shell they
 * disagree in *both* shape and `rev` (measured 2026-09-30; `working-docs/
 * DESKTOP-PROBE-2026-09-30.md` §5):
 *
 *   boot JSON roster    {"id":"dsh-pet-bridge","url":"plugins/??dsh-pet-bridge/client.js&rev=…",…}
 *                       → the plugin stands alone, so this URL serves its own bundle
 *   inline `<script src>`  plugins/??@deepseek-ai/…,dsh-pet-bridge/client.js&amp;rev=…
 *                       → one of 65 packages, escaped, and that group rev does NOT resolve to a
 *                         single-file path (fetching it 404s)
 *
 * `rev` is therefore a routing key, not a cache-buster: only the exact published rev serves
 * bytes. The result must be a URL the shell actually names, never a reconstruction, and it must
 * be the *standalone* shape — handing over a group URL would 404 and turn a healthy host into a
 * false red. A position-free `plugins/??…` scan cannot do this: `@deepseek-ai/` contains a
 * slash, so no bounded pattern can tell a same-group sibling (`…/a/client.js`) from the next
 * attribute (`"url":"…"`). Hence `scriptUrls` (already `&amp;`-decoded) is passed in rather than
 * re-scanned here.
 *
 * @param html - the authenticated app shell.
 * @param scriptUrls - the shell's own decoded script/link references.
 * @returns the resolvable client URL, or `undefined` when the plugin is not in this profile.
 */
export function resolvePetClientUrl(html, scriptUrls = []) {
  const isStandalone = (candidate) =>
    candidate !== undefined
    && /(?:^|\/)plugins\/\?\?dsh-pet-bridge\/client\.js[&"'\s]/.test(candidate)
  const fromBootJson = /"id"\s*:\s*"dsh-pet-bridge"[^}]*?"url"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const fromScript = scriptUrls.find((url) => url.includes('dsh-pet-bridge/client.js'))
  return [fromBootJson, fromScript].find(isStandalone)
}
