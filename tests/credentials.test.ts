/**
 * Credential-publishing rules.
 *
 * `npm run check` starts real control listeners with `controlPort: 0`. Until
 * this rule existed, every one of them called `writeTokenFile` on the *shared*
 * `~/.dsh/pet-bridge.json`, so a test run replaced the credentials of whatever
 * DSH was already serving: the file named a random port and carried a token the
 * live listener rejects. The bridge itself kept working — it holds its token in
 * memory — and the suite stayed green, which is exactly why nothing caught it.
 * The damage only appeared for the *next* consumer of that file: a freshly
 * started pet, the mock pet, or the CDP driver.
 *
 * The rule is structural rather than a convention: a listener that was asked
 * for an ephemeral port publishes nothing at all unless it is handed an
 * explicit path. These tests pin that, plus the ordinary case of an explicit
 * path being honoured.
 *
 * @module tests/credentials
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { StatePayload } from '../src/protocol.js'
import { bridge } from './harness.js'

const { PROTOCOL_VERSION, startControlServer, tokenFilePath, writeTokenFile } = bridge

/** A shrink-wrapped file identity, or null when the file does not exist. */
function statOrNull(path: string): { size: number, mtimeMs: number } | null {
  try {
    const info = statSync(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/** Collaborators for a listener whose routes are never called. */
const idleDeps = {
  statePayload: (): StatePayload => ({
    v: PROTOCOL_VERSION,
    revision: 0,
    sessions: [],
    notices: [],
    petPort: null,
    browserRoutes: false,
  }),
  onHello: () => {},
  onAck: () => null,
}

describe('control credential publishing', () => {
  it('resolves the shared path by default and honours an override', () => {
    const shared = tokenFilePath()
    assert.equal(shared.endsWith(join('.dsh', 'pet-bridge.json')), true, `unexpected shared path: ${shared}`)
    assert.equal(tokenFilePath(join('tmp', 'custom.json')), join('tmp', 'custom.json'))
    assert.equal(tokenFilePath(''), shared, 'an empty override falls back to the shared path')
  })

  it('writes an explicit path and leaves the shared file untouched', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-credentials-'))
    const custom = join(scratch, 'pet-bridge.json')
    const sharedBefore = statOrNull(tokenFilePath())
    try {
      assert.equal(writeTokenFile(4711, 'a'.repeat(64), custom), null)
      const published = JSON.parse(readFileSync(custom, 'utf8')) as Record<string, unknown>
      assert.equal(published.v, PROTOCOL_VERSION)
      assert.equal(published.controlPort, 4711)
      assert.equal(published.token, 'a'.repeat(64))
      assert.equal(typeof published.writtenAt, 'string')
      assert.deepEqual(statOrNull(tokenFilePath()), sharedBefore, 'the shared credentials were not touched')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('publishes nothing for an ephemeral port without an explicit path', async () => {
    const sharedBefore = statOrNull(tokenFilePath())
    const result = await startControlServer({ port: 0, ...idleDeps })
    try {
      assert.equal(result.ok, true, 'the listener still binds')
      assert.deepEqual(
        statOrNull(tokenFilePath()),
        sharedBefore,
        'an ephemeral-port listener must not rewrite the shared credentials',
      )
    } finally {
      if (result.ok) await result.server.close()
    }
  })

  it('publishes to the explicit path when an ephemeral port does opt in', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-credentials-'))
    const custom = join(scratch, 'pet-bridge.json')
    const sharedBefore = statOrNull(tokenFilePath())
    const result = await startControlServer({ port: 0, tokenFile: custom, ...idleDeps })
    try {
      assert.equal(result.ok, true)
      if (!result.ok) return
      const published = JSON.parse(readFileSync(custom, 'utf8')) as Record<string, unknown>
      assert.equal(published.controlPort, result.server.port, 'the published port is the bound one')
      assert.equal(published.token, result.server.token, 'the published token is the minted one')
      assert.deepEqual(statOrNull(tokenFilePath()), sharedBefore, 'the shared credentials were not touched')
    } finally {
      if (result.ok) await result.server.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
