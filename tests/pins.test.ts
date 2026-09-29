/**
 * Guards for the compile-time pins in `src/pins.ts`.
 *
 * The pins exist to make a harness shape drift break `npm run typecheck`. That
 * only works if the mechanism itself is checked — the *previous* form
 * (`X extends Face ? true : never` on an alias nobody reads) compiled clean
 * while silently resolving to `never`, so a drift passed the gate unnoticed.
 *
 * Crucially, this file imports the **production** `Assert` and `Satisfies`
 * rather than re-declaring them. A local copy would keep passing even if the
 * production pin were reverted to an inert form, which is the one regression
 * this file exists to prevent. The negative case below therefore fails the build
 * whenever the real mechanism stops rejecting drift:
 *
 * - `Assert` loses its constraint (`type Assert<T> = T`) -> no error -> the
 *   `@ts-expect-error` below is unused -> `TS2578`.
 * - `Satisfies` reverts to `? true : never` -> the negative case becomes
 *   `Assert<never>`, and `never` satisfies every constraint, so again no error
 *   -> `TS2578`.
 *
 * @module tests/pins
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Assert, PinnedHarnessShapes, Satisfies, SessionFace } from './harness.js'

/** A value that satisfies the face: the pin must accept it. */
type _Satisfied = Assert<Satisfies<{ id: unknown, header: { cwd?: string } }, SessionFace>>

/**
 * A value missing a required member: the pin must reject it.
 *
 * `@ts-expect-error` is load-bearing — see the module comment for the two
 * production regressions it catches.
 */
// @ts-expect-error a face missing `header` must not satisfy the pin
type _Drifted = Assert<Satisfies<{ id: unknown }, SessionFace>>

/*
 * The pin inventory is asserted too, so removing a pin (rather than weakening
 * the mechanism) is also a build failure: `_ReasonsCovered` is the one that
 * keeps a future DSH turn-end kind from being silently degraded.
 */
type _PinCount = Assert<PinnedHarnessShapes['length'] extends 3 ? true : false>
type _PinsHold = Assert<PinnedHarnessShapes[number] extends true ? true : false>

describe('compile-time pins', () => {
  it('binds the drift guard to the production mechanism', () => {
    // Nothing to assert at runtime: `_Drifted` fails at compile time, and the
    // inventory aliases above fail if a pin is dropped. Reaching this line at
    // all means the production `Assert` / `Satisfies` still reject drift.
    assert.ok(true)
  })
})
