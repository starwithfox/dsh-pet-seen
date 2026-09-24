/**
 * Bundle smoke test.
 *
 * Everything else in the suite runs against the TypeScript sources. This script
 * is the one check that loads the **built** artifacts the way the DSH loader
 * will, so a bundling mistake — a missing external, a broken wrapper, a
 * surprise import in the client factory — fails here instead of in a user's
 * session.
 *
 * Checks, in order:
 *
 * 1. `lib/index.js` imports as ESM and exposes `apply`, `Config` and `name`.
 * 2. Its only external imports are Node builtins and
 *    `@deepseek-ai/schemastery`.
 * 3. `client/client.js` is a `window.__ModuleLoader__.load` factory for
 *    `dsh-pet-bridge` and contains **no** runtime import or `require` call.
 * 4. `cordis.patch.yml` inserts exactly the entry the package name implies.
 *
 * @module tools/smoke-bundle
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const failures = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* 1. Host bundle loads and exposes the loader contract. ------------------- */
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
check('host bundle exports name/apply/Config', () => {
  assert.equal(host.name, 'dsh-pet-bridge')
  assert.equal(typeof host.apply, 'function')
  assert.ok(host.Config !== undefined, 'Config schema is exported')
  assert.equal(typeof host.NoticeStore, 'function', 'pure logic is reachable too')
})

/* 2. Host bundle externals. ---------------------------------------------- */
const hostSource = read('lib/index.js')
check('host bundle externalizes only node builtins + schemastery', () => {
  const specifiers = [...hostSource.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1])
  const unexpected = specifiers.filter((specifier) => {
    if (specifier.startsWith('node:')) return false
    if (specifier === '@deepseek-ai/schemastery') return false
    return true
  })
  assert.deepEqual(unexpected, [], `unexpected externals: ${unexpected.join(', ')}`)
  assert.equal(
    specifiers.includes('@deepseek-ai/schemastery'),
    true,
    'schemastery must stay external: the profile provides it',
  )
  for (const forbidden of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent', '@deepseek-ai/cordis']) {
    assert.equal(
      specifiers.some(specifier => specifier.startsWith(forbidden)),
      false,
      `${forbidden} must not be a runtime import`,
    )
  }
})

/* 3. Client bundle purity. ----------------------------------------------- */
const clientSource = read('client/client.js')
check('client bundle is a ModuleLoader factory with no runtime imports', () => {
  assert.equal(clientSource.includes('window.__ModuleLoader__.load'), true)
  assert.equal(clientSource.includes('id: "dsh-pet-bridge"'), true)
  assert.equal(clientSource.includes('factory: (require) =>'), true)
  // No static imports and no require() calls: this half renders no UI, so it
  // needs no externals at all.
  assert.equal(/^\s*import\s/m.test(clientSource), false, 'no static import statements')
  assert.equal(/\brequire\(/.test(clientSource), false, 'no require() calls')
  assert.equal(/from\s+["']/.test(clientSource), false, 'no from-clauses')
})

/* 4. Bundle patch. ------------------------------------------------------- */
check('cordis.patch.yml inserts the documented loader entry', () => {
  const patch = read('cordis.patch.yml')
  assert.equal(patch.includes('- insert:'), true)
  assert.equal(patch.includes('id: dsh-pet-bridge'), true)
  assert.equal(patch.includes('name: dsh-pet-bridge'), true)
})

/* 5. Manifest wiring. ---------------------------------------------------- */
check('package.json wires the bundle and client entries', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-pet-bridge')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client/client.js')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.main, 'lib/index.js')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle check(s) failed`)
  process.exit(1)
}
console.log('\nall bundle checks passed')
