/**
 * The module under test.
 *
 * Tests import the TypeScript sources, so the suite type-checks and exercises
 * exactly the code that ships, with one compile and no declaration-emitting
 * pass in between. The single indirection here keeps that decision out of every
 * test file.
 *
 * The built bundle is verified separately: `npm run smoke:bundle` loads
 * `lib/index.js` the same way the DSH loader will, which is the only check that
 * can catch a bundling mistake.
 *
 * @module tests/harness
 */

export * as bridge from '../src/index.js'
