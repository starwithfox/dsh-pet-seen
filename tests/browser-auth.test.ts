#!/usr/bin/env node
/**
 * Smoke test for `tools/browser-auth.mjs#resolvePetClientUrl`.
 *
 * The fixtures are the *real* shapes the 0.2.0-rc.2 desktop shell emitted on 2026-09-30
 * (`working-docs/DESKTOP-PROBE-2026-09-30.md` §5). They are kept verbatim — including the
 * `&amp;` escaping and the 65-package tail — because the bug this pins was invisible against a
 * simplified fixture: a position-free `plugins/??…` scan swallowed the whole shared group and
 * produced a URL whose `rev` is scoped to that group. Fetching a group rev for a single-file
 * path returns 404, so accepting one turns the probe's gate into a false red on a healthy host.
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Two levels up: the compiled copy runs from `test-dist/tests/`, the source from `tests/`.
const TOOL_URL = new URL(`file://${join(HERE, '..', '..', 'tools', 'browser-auth.mjs')}`).href

type ResolvePetClientUrl = (html: string, scriptUrls?: string[]) => string | undefined

// The tool is plain JavaScript with no declarations, so it is imported dynamically and the
// production function is asserted (not re-declared) — a copy here would not pin the tool.
const tools = await import(/* @vite-ignore */ TOOL_URL) as { resolvePetClientUrl?: ResolvePetClientUrl }
const resolvePetClientUrl = tools.resolvePetClientUrl
assert.equal(typeof resolvePetClientUrl, 'function', 'browser-auth.mjs must export resolvePetClientUrl')
const resolve = resolvePetClientUrl as ResolvePetClientUrl

/** The boot JSON roster entry, verbatim from the 0.2.0-rc.2 desktop shell. */
const BOOT_ENTRY = '{"id":"dsh-pet-bridge","url":"plugins/??dsh-pet-bridge/client.js&rev=cc6e904cfa63","rev":"cc6e904cfa63","inject":[]}'
const BOOT_URL = 'plugins/??dsh-pet-bridge/client.js&rev=cc6e904cfa63'

/** The shared `<script src>` group, verbatim minus the 56 unrelated packages. */
const SCANNED_GROUP = 'plugins/??@deepseek-ai/dsh-session-log-export/client.js,@deepseek-ai/dsh-api-session-controller/client.js,dsh-pet-bridge/client.js&amp;rev=746d7e975124'
const DECODED_GROUP = 'plugins/??@deepseek-ai/dsh-session-log-export/client.js,@deepseek-ai/dsh-api-session-controller/client.js,dsh-pet-bridge/client.js&rev=746d7e975124'

describe('resolvePetClientUrl (tools/browser-auth.mjs)', () => {
  it('prefers the standalone boot JSON entry over the shared script group', () => {
    const html = `<script src="${SCANNED_GROUP}"></script><script>globalThis["__DSH_BOOT__"]=[${BOOT_ENTRY}]</script>`
    assert.equal(
      resolve(html, [DECODED_GROUP]),
      BOOT_URL,
      'the boot entry is the URL that serves the bundle; the group rev does not resolve',
    )
  })

  it('never reconstructs a URL from a shared group, even with no boot JSON', () => {
    const html = `<script src="${SCANNED_GROUP}"></script>`
    assert.equal(
      resolve(html, [DECODED_GROUP]),
      undefined,
      'a group URL cannot be fetched (404), so it must be rejected rather than reported as the bundle',
    )
  })

  it('still finds a single-package script group when the boot JSON is absent', () => {
    const url = 'plugins/??dsh-pet-bridge/client.js&rev=abc123'
    assert.equal(resolve(`<script src="${url}"></script>`, [url]), url)
  })

  it('tolerates a leading slash, which older shells carry', () => {
    const url = '/plugins/??dsh-pet-bridge/client.js&rev=abc123'
    assert.equal(resolve(`<script src="${url}"></script>`, [url]), url)
  })

  it('reports nothing when the plugin is absent from this profile', () => {
    const other = 'plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=abc123'
    assert.equal(resolve(`<script src="${other}"></script>`, [other]), undefined)
    assert.equal(resolve('', []), undefined)
  })

  it('is not fooled by the plugin name appearing in an unrelated roster', () => {
    const trailing = '{"ids":["dsh-pet-bridge"]}'
    assert.equal(resolve(`<script>${trailing}</script>`, []), undefined)
  })
})
