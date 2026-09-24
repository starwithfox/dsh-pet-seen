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
 */
import { defineConfig } from 'tsdown'

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
    deps: { neverBundle: [] },
    outputOptions: {
      banner: 'window.__ModuleLoader__.load({ id: "dsh-pet-bridge", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
