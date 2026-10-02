/**
 * The host-coupling surface: everything this plugin assumes about DSH, plus the
 * compile-time enforcement of those assumptions.
 *
 * This module exists so that the *only* place the plugin touches DSH's internal
 * types is one file. Everything else (`protocol.ts` especially) is the
 * language-neutral wire contract another pet implementation would target, and
 * the host bundle never links a harness package at runtime: these are type-only
 * references, erased at build time.
 *
 * Why the mechanism lives here rather than in `src/index.ts`, and why it is
 * exported: the regression test has to exercise the *production* `Assert` and
 * `Satisfies`, not a copy. A test that re-declares them cannot stop anyone from
 * reverting the production pin to an inert form — which is precisely the defect
 * the pins exist to prevent. Keeping the mechanism on a shared module boundary
 * means one definition, used by both the pins below and `tests/pins.test.ts`.
 *
 * @module dsh-pet-seen/pins
 */

import type { TurnEndKind } from './protocol.js'

/* ------------------------------------------------------------------ *
 * The mechanism
 * ------------------------------------------------------------------ */

/**
 * Fails to compile unless `T` is exactly `true`.
 *
 * The constraint is checked wherever this is instantiated, so `Assert<false>` is
 * a hard `TS2344` even on an alias nobody reads. That is the whole point: the
 * earlier form — `X extends Face ? true : never` — was silently inert, because
 * an unused alias resolving to `never` compiles clean.
 */
export type Assert<T extends true> = T

/**
 * `true` when `Actual` still satisfies `Face`, `false` otherwise.
 *
 * Split out from {@link Assert} so the drift test can feed it a deliberately
 * broken `Actual` and still be running the production comparison.
 */
export type Satisfies<Actual, Face> = Actual extends Face ? true : false

/* ------------------------------------------------------------------ *
 * The faces
 * ------------------------------------------------------------------ */

/*
 * Minimal structural faces for the harness values this plugin touches.
 *
 * Declaring them rather than importing the harness classes keeps the host bundle
 * free of harness imports, and keeps the plugin compiling against a harness
 * whose internal type names moved - only the pins below have to be revisited.
 */

/** The slice of `Session` this plugin reads. */
export interface SessionFace {
  readonly id: unknown
  readonly header: {
    readonly cwd?: string
    /** Present exactly for subagent sessions. */
    readonly origin?: 'subagent'
    /** Session title, when the store keeps one on the header. */
    readonly title?: string
  }
}

/** The slice of one `session/event` entry this plugin reads. */
export interface SessionEventFace {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** The slice of `Agent` this plugin reads. */
export interface AgentFace {
  readonly session: SessionFace
  readonly status: 'idle' | 'running'
}

/** The `session/event` listener signature. */
export type SessionEventListener = (session: SessionFace, event: SessionEventFace) => void

/** The `agent/status` listener signature. */
export type AgentStatusListener = (payload: { agent: AgentFace, status: 'idle' | 'running' }) => void

/** The `agent/error` listener signature. */
export type AgentErrorListener = (payload: { agent: AgentFace, error: unknown }) => void

/* ------------------------------------------------------------------ *
 * The pins
 * ------------------------------------------------------------------ */

/*
 * These are meant to break the build on a DSH upgrade. That is the cheaper
 * failure: the alternative is a face silently no longer matching, or
 * `turnEndKind` quietly degrading a brand-new reason to a default and telling
 * the user their failed run finished.
 */

type _SessionPinned = Assert<Satisfies<import('@deepseek-ai/dsh-session').Session, SessionFace>>
type _AgentPinned = Assert<Satisfies<import('@deepseek-ai/dsh-agent').Agent, AgentFace>>
/** Every harness turn-end kind must be one `TurnEndKind` names. See `turnEndKind`. */
type _ReasonsCovered = Assert<
  Satisfies<import('@deepseek-ai/dsh-session').TurnEndReason['kind'], TurnEndKind>
>

/** The pin inventory. Its length and elements are asserted by `tests/pins.test.ts`. */
export type PinnedHarnessShapes = [_SessionPinned, _AgentPinned, _ReasonsCovered]
