/**
 * Build configuration for both halves of the plugin.
 *
 * Two independent builds, deliberately:
 *
 * - **Host (ESM, Node).** Bundled so the published package needs no harness
 *   packages at run time; `@deepseek-ai/schemastery` stays external because the
 *   profile's own `node_modules` already provides it. Type checking and `.d.ts`
 *   emission are a separate `tsc` pass (`tsconfig.types.json`).
 * - **Client (CJS factory, browser).** The DSH client module system serves this
 *   file and expects a lazily loaded factory registered on
 *   `window.__ModuleLoader__`, receiving a `require` for its externals. That
 *   preset is not published, so it is reproduced here. This half renders no UI
 *   and therefore imports nothing at all — the bundle is the strongest possible
 *   form of the client bundle-purity gate.
 *
 * Both halves are also handed the **build identity** (`tools/build-id.mjs`
 * through `define`): one value for both, derived from the version and every file
 * under `src/`. That is what makes "are the host half and the page half the same
 * build?" answerable by comparing two strings — the build handshake, PL-EN-NW-02.
 * A `define` is used rather than a generated source file so that nothing tracked
 * has to be regenerated, and the build stays deterministic.
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { computeBuildId, readPluginVersion } from './tools/build-id.mjs'

const root = dirname(fileURLToPath(import.meta.url))

/** Values baked into both bundles; the source declares them as ambient consts. */
const buildIdentity = {
  __PET_BUILD_ID__: JSON.stringify(computeBuildId(root)),
  __PET_PLUGIN_VERSION__: JSON.stringify(readPluginVersion(root)),
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    outDir: 'lib',
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    define: buildIdentity,
    // `noCheck` on purpose: type checking is `tsconfig.check.json`, which
    // resolves the harness declarations from the *live* DSH installation. A
    // bundler run must not depend on a developer's DSH layout.
    tsconfig: 'tsconfig.host.json',
    deps: { neverBundle: ['@deepseek-ai/schemastery'] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    dts: false,
    outDir: 'client',
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    define: buildIdentity,
    deps: { neverBundle: [] },
    outputOptions: {
      banner: 'window.__ModuleLoader__.load({ id: "dsh-pet-seen", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
