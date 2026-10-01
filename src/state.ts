/**
 * The host-side state machine: per-session progress buckets and per-run
 * completion notices.
 *
 * Three facts drive the whole design and are worth stating once here:
 *
 * 1. **`turn/end` does not end a run.** A goal round, a queued follow-up, or a
 *    continuation can open another turn immediately. So `turn/end` is only
 *    *recorded*; the notice is produced when the agent actually reaches idle.
 * 2. **Idle and `turn/end` come from different sources.** Idle arrives from the
 *    `agent/status` event, `turn/end` from the session log. Either may land
 *    first, so an idle observation with no recorded reason waits out a bounded
 *    grace window instead of dropping the notification.
 * 3. **State is bucketed by session, never global.** With several sessions
 *    running in parallel, a single global running/idle flag would attribute a
 *    completion to the wrong conversation.
 *
 * This module is deliberately pure: it receives events and an explicit `at`
 * time and returns the effects to apply. It starts no timers and reads no
 * clock, which is what makes the awkward orderings in point 2 testable.
 *
 * @module dsh-pet-bridge/state
 */

import type {
  NoticeSnapshot,
  NoticeState,
  PetEvent,
  SessionProgressSnapshot,
  SessionReaderIndex,
  TurnEndKind,
  TurnEndRecord,
} from './protocol.js'
import { MAX_MESSAGE_LENGTH, PROTOCOL_VERSION, clampText, clampTitle } from './protocol.js'

/** Outcome of one completed run, ready to be turned into exactly one notice. */
export interface RunCompletion {
  readonly sessionId: string
  readonly runId: string
  readonly reason: TurnEndKind
  readonly targetTurnRef: string | null
  readonly completedAt: number
}

/** Effects the caller must perform after a state transition. */
export interface StateEffects {
  /** Runs that just finished and now each deserve one notice. */
  readonly completions: readonly RunCompletion[]
  /** Whether the outward-facing snapshot changed. */
  readonly changed: boolean
}

/** Retention and timing bounds; every one exists so a long-lived host cannot leak. */
export interface NoticeStoreOptions {
  /** Maximum retained notices; settled notices are evicted oldest-first. */
  readonly maxNotices: number
  /** Age after which a settled notice is dropped, in ms. */
  readonly noticeTtlMs: number
  /** Grace given to a late `turn/end` after idle is observed, in ms. */
  readonly idleGraceMs: number
}

/** Internal run bookkeeping for one root session. */
interface RunState {
  runId: string
  startedAt: number
  /** Last `turn/end` recorded during this run. */
  lastTurnEnd: TurnEndRecord | null
  /** Set once idle is observed but no reason is available yet. */
  idlePendingSince: number | null
  /** Set once this run's completion has been consumed into a notice. */
  settled: boolean
  toolCalls: number
  lastTool: string | null
  todoCount: number
  completedTodoCount: number
}

/** Internal per-session bucket. */
interface SessionState {
  sessionId: string
  title: string | null
  cwd: string | null
  /** True for subagent sessions, which never appear in the pet's view. */
  subagent: boolean
  /** Set when the session was removed; kept only to stop re-adding it. */
  removed: boolean
  running: boolean
  run: RunState | null
  updatedAt: number
  /**
   * Which page read last named this session, or null when none has reported.
   *
   * Null and `-1` are different facts and must not be collapsed: null means "no
   * page has told us", while `-1` means "a page looked and found nothing" —
   * except that the second can never be recorded here, because a `-1` reading
   * carries no session id to record it against. The host keeps those in the
   * per-tab diagnostics instead.
   */
  reader: SessionReaderIndex | null
}

/** Options for {@link NoticeStore.recordProgress}. */
export interface ProgressFacts {
  /** Tool *name* only. Raw arguments are never accepted here. */
  tool?: string | null
  /** Number of todo items in the current run; content is never accepted. */
  todoCount?: number
  completedTodoCount?: number
}

/** Session facts learned outside the event stream (title/cwd are not on `session/event`). */
export interface SessionFacts {
  title?: string | null
  cwd?: string | null
  subagent?: boolean
  /**
   * Which page read named this session, when the caller learned one.
   *
   * Only ever set together with a real session id: `-1` is reported through the
   * per-tab diagnostics, which do not need a session to exist.
   */
  reader?: SessionReaderIndex
}

/**
 * Per-session progress and notice store.
 *
 * Callers advance grace deadlines through {@link consumeTime} rather than the
 * store scheduling its own timers.
 */
export class NoticeStore {
  private readonly sessions = new Map<string, SessionState>()
  private readonly notices = new Map<string, NoticeRecord>()
  private readonly options: NoticeStoreOptions
  private revision = 0

  /**
   * @param options - retention and grace bounds.
   */
  constructor(options: NoticeStoreOptions) {
    this.options = options
  }

  /** Monotonic snapshot revision, bumped by every outward-visible change. */
  get snapshotRevision(): number {
    return this.revision
  }

  /**
   * Record that a root session started running.
   *
   * A new run mints a fresh run id and drops the previous run's recorded reason,
   * so a stale completion can never be attributed to the new run. A duplicate
   * `running` report for an already-running session is not a new run.
   *
   * @param sessionId - root session id.
   * @param runId - id minted by the caller for this run.
   * @param at - epoch ms of the observation.
   * @param facts - optional session facts known at run start.
   * @returns the effects to apply.
   */
  startRun(sessionId: string, runId: string, at: number, facts: SessionFacts = {}): StateEffects {
    const bucket = this.bucket(sessionId, at)
    this.applyFacts(bucket, facts)
    const previous = bucket.run
    // A duplicate `running` report is not a new run — but only while the
    // current run has no outcome yet. Once a turn has ended and another opens,
    // this really is the next run, even though idleness has not been observed.
    const duplicate = bucket.running
      && previous !== null
      && !previous.settled
      && previous.lastTurnEnd === null
    if (duplicate) {
      bucket.updatedAt = at
      return { completions: [], changed: false }
    }
    bucket.running = true
    bucket.updatedAt = at
    bucket.run = freshRun(runId, at)
    this.revision += 1
    return { completions: [], changed: true }
  }

  /**
   * Record one `turn/end`.
   *
   * Never produces a completion on its own: the run may continue, because a
   * goal round or a queued follow-up opens the next turn immediately. When an
   * idle observation is already pending, the arriving reason settles it at once
   * instead of waiting out the grace window.
   *
   * A `turn/end` with no observed run start (the plugin mounted mid-run, or a
   * resumed session) mints a provisional run so the eventual idle can still
   * settle. A real `turn/start` or `agent/status: running` supersedes it, which
   * is why the provisional run id is namespaced and never reported as a real
   * run id by the caller.
   *
   * @param sessionId - root session id.
   * @param turn - the ended turn's number; used as the page-matchable reference.
   * @param reason - the turn-end kind.
   * @param at - epoch ms of the observation.
   * @returns the effects to apply.
   */
  recordTurnEnd(sessionId: string, turn: number, reason: TurnEndKind, at: number): StateEffects {
    const bucket = this.bucket(sessionId, at)
    let run = bucket.run
    if (run === null) {
      run = freshRun(`provisional:${sessionId}`, at)
      bucket.run = run
    }
    run.lastTurnEnd = { turn, kind: reason, at }
    bucket.updatedAt = at
    this.revision += 1
    // A reason settles a pending idle whenever it lands. Grace is the *waiting*
    // bound, not an expiry on the reason: a slightly late `turn/end` still
    // describes a run that finished, and dropping it would lose a real
    // completion. Once the window has run out the caller may already have
    // decided not to wait, in which case the run is settled and this is a no-op.
    if (run.idlePendingSince !== null && !run.settled) {
      return { completions: [this.settle(bucket, run, at)], changed: true }
    }
    return { completions: [], changed: true }
  }

  /**
   * Record that a session reached `idle`.
   *
   * With a recorded reason this settles the run immediately. Without one it
   * opens the grace window, because `turn/end` may still be in flight.
   *
   * @param sessionId - root session id.
   * @param at - epoch ms of the observation.
   * @returns the effects to apply.
   */
  recordIdle(sessionId: string, at: number): StateEffects {
    const bucket = this.sessions.get(sessionId)
    if (bucket === undefined) return { completions: [], changed: false }
    bucket.running = false
    bucket.updatedAt = at
    this.revision += 1
    const run = bucket.run
    if (run === null || run.settled) return { completions: [], changed: true }
    if (run.lastTurnEnd !== null) return { completions: [this.settle(bucket, run, at)], changed: true }
    run.idlePendingSince = at
    return { completions: [], changed: true }
  }

  /**
   * Advance grace deadlines and expire old notices. Call from a timer; the
   * store never schedules anything itself.
   *
   * A pending idle whose grace expires with no recorded reason produces no
   * notice, and the run is retired on the spot. That is the conservative
   * choice: with no reason in hand "completed" would be a guess, and a wrong
   * "your task finished" is worse than a missing one. Retiring the run also
   * means a reason that shows up much later cannot resurrect it — that would be
   * a different, already-reported run.
   *
   * @param at - epoch ms to evaluate against.
   * @returns the effects to apply.
   */
  consumeTime(at: number): StateEffects {
    const completions: RunCompletion[] = []
    let changed = false
    for (const bucket of this.sessions.values()) {
      const run = bucket.run
      if (run === null || run.settled || run.idlePendingSince === null) continue
      if (at - run.idlePendingSince < this.options.idleGraceMs) continue
      run.idlePendingSince = null
      if (run.lastTurnEnd === null) {
        // Reason never arrived: settle nothing and report nothing.
        run.settled = true
        bucket.running = false
        bucket.updatedAt = at
        changed = true
        continue
      }
      completions.push(this.settle(bucket, run, at))
      changed = true
    }
    if (this.expireNotices(at)) changed = true
    return { completions, changed }
  }

  /**
   * Record progress that does not change the run lifecycle.
   *
   * @param sessionId - root session id.
   * @param at - epoch ms of the observation.
   * @param progress - bounded counts and the tool's name only.
   * @returns the effects to apply.
   */
  recordProgress(sessionId: string, at: number, progress: ProgressFacts): StateEffects {
    const bucket = this.sessions.get(sessionId)
    if (bucket === undefined) return { completions: [], changed: false }
    const run = bucket.run
    if (run === null || run.settled) return { completions: [], changed: false }
    if (progress.tool !== undefined) {
      run.toolCalls += 1
      run.lastTool = clampText(progress.tool, 200) ?? null
    }
    if (progress.todoCount !== undefined) run.todoCount = Math.max(0, progress.todoCount)
    if (progress.completedTodoCount !== undefined) {
      run.completedTodoCount = Math.max(0, progress.completedTodoCount)
    }
    bucket.updatedAt = at
    this.revision += 1
    return { completions: [], changed: true }
  }

  /**
   * Store session facts learned outside the event stream.
   *
   * The page is the source of two of these: the title (which only the client
   * snapshot has) and `reader` (which read named the session), both observed on
   * a `POST /pet-bridge/visibility`.
   *
   * @param sessionId - root session id.
   * @param facts - only the fields whose values are known.
   * @param at - epoch ms of the observation.
   */
  recordSessionFacts(sessionId: string, facts: SessionFacts, at: number): void {
    const bucket = this.bucket(sessionId, at)
    if (this.applyFacts(bucket, facts)) {
      bucket.updatedAt = at
      this.revision += 1
    }
  }

  /**
   * Mark a session removed: it stops running and leaves the pet's view without
   * pretending to be a subagent.
   *
   * @param sessionId - session id to remove.
   * @param at - epoch ms of the observation.
   * @returns whether the session was known.
   */
  removeSession(sessionId: string, at: number): boolean {
    const bucket = this.sessions.get(sessionId)
    if (bucket === undefined) return false
    bucket.removed = true
    bucket.running = false
    bucket.updatedAt = at
    this.revision += 1
    return true
  }

  /**
   * Store a produced notice so later observations and pet acks can find it.
   *
   * @param completion - the settled run.
   * @param noticeId - id the pet keys its popup on.
   * @param at - epoch ms the notice was created.
   * @returns the stored notice snapshot.
   */
  createNotice(completion: RunCompletion, noticeId: string, at: number): NoticeSnapshot {
    const record: NoticeRecord = {
      noticeId,
      sessionId: completion.sessionId,
      runId: completion.runId,
      targetTurnRef: completion.targetTurnRef,
      reason: completion.reason,
      completedAt: completion.completedAt,
      state: 'pending',
      seenAt: null,
      delivered: false,
      deliveredSeen: false,
      deliveredAt: null,
    }
    this.notices.set(noticeId, record)
    this.expireNotices(at)
    this.revision += 1
    return toSnapshot(record)
  }

  /**
   * Mark a notice as handed to the pet.
   *
   * @param noticeId - target notice.
   * @param seen - whether the completion event advertised `seen: true`.
   * @param at - epoch ms of the delivery.
   * @returns the updated notice, or null when unknown/expired.
   */
  markDelivered(noticeId: string, seen: boolean, at: number): NoticeSnapshot | null {
    const record = this.notices.get(noticeId)
    if (record === undefined) return null
    record.delivered = true
    record.deliveredSeen = seen
    record.deliveredAt = at
    if (seen && record.state === 'pending') {
      record.state = 'seen'
      record.seenAt = at
    }
    this.revision += 1
    return toSnapshot(record)
  }

  /**
   * Apply a pet acknowledgement.
   *
   * `dismissed` retires the notice permanently: a notice the user closed is
   * over, so a duplicate or out-of-order `shown` cannot reopen the popup. A
   * `shown` acknowledgement on an already-`seen` notice is likewise ignored,
   * because an observed notice was suppressed rather than displayed.
   *
   * @param noticeId - target notice.
   * @param action - `shown` or `dismissed`.
   * @returns the resulting state, or null when the notice is unknown.
   */
  applyAck(noticeId: string, action: 'shown' | 'dismissed'): NoticeState | null {
    const record = this.notices.get(noticeId)
    if (record === undefined) return null
    if (record.state === 'seen' || record.state === 'dismissed') return record.state
    const next: NoticeState = action === 'shown' ? 'shown' : 'dismissed'
    if (record.state === next) return record.state
    record.state = next
    this.revision += 1
    return record.state
  }

  /**
   * Accept an L3 observation from the browser.
   *
   * All three identifiers must agree with the stored notice and the notice must
   * still be open. This is the only path that moves a notice to `seen`.
   *
   * @param input - the observation's notice/run/session triple.
   * @param at - epoch ms of the observation.
   * @returns whether it was accepted, why not when it was not, and the notice.
   */
  applyObservation(
    input: { noticeId: string, runId: string, sessionId: string },
    at: number,
  ): { accepted: boolean, reason?: string, notice: NoticeSnapshot | null } {
    const record = this.notices.get(input.noticeId)
    if (record === undefined) return { accepted: false, reason: 'unknown-notice', notice: null }
    if (record.runId !== input.runId) {
      return { accepted: false, reason: 'run-mismatch', notice: toSnapshot(record) }
    }
    if (record.sessionId !== input.sessionId) {
      return { accepted: false, reason: 'session-mismatch', notice: toSnapshot(record) }
    }
    if (record.state === 'dismissed') {
      return { accepted: false, reason: 'already-dismissed', notice: toSnapshot(record) }
    }
    if (record.state === 'seen') return { accepted: true, notice: toSnapshot(record) }
    record.state = 'seen'
    record.seenAt = at
    this.revision += 1
    return { accepted: true, notice: toSnapshot(record) }
  }

  /**
   * Open notices for one session, oldest first.
   *
   * "Open" means every state the user has not settled yet: `pending` **and**
   * `shown`. `shown` must stay visible to the page, because the popup being on
   * screen is exactly the case the automatic cancellation exists for — the user
   * reads the result and the pet retracts a popup it already raised. Only the
   * terminal states are withheld: `seen` is already retired, and `dismissed`
   * was closed by the user.
   *
   * This list does not drive popups, so including `shown` cannot open a second
   * one: the pet's popup comes from the pushed `completed` event, and is
   * suppressed for a notice it has already acknowledged.
   *
   * @param sessionId - session to filter by.
   * @returns snapshots the browser may watch for.
   */
  pendingFor(sessionId: string): NoticeSnapshot[] {
    const rows: NoticeSnapshot[] = []
    for (const record of this.notices.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.state === 'seen' || record.state === 'dismissed') continue
      rows.push(toSnapshot(record))
    }
    rows.sort((left, right) => left.completedAt - right.completedAt)
    return rows
  }

  /** All retained notices, oldest first, for the pet's `/state` snapshot. */
  allNotices(): NoticeSnapshot[] {
    const rows = [...this.notices.values()].map(toSnapshot)
    rows.sort((left, right) => left.completedAt - right.completedAt)
    return rows
  }

  /** One notice by id, or null when unknown. */
  notice(noticeId: string): NoticeSnapshot | null {
    const record = this.notices.get(noticeId)
    return record === undefined ? null : toSnapshot(record)
  }

  /** Visible root-session progress buckets, most recently active first. */
  progressSnapshot(): SessionProgressSnapshot[] {
    const rows: SessionProgressSnapshot[] = []
    for (const bucket of this.sessions.values()) {
      if (bucket.subagent || bucket.removed) continue
      rows.push({
        sessionId: bucket.sessionId,
        title: bucket.title,
        cwd: bucket.cwd,
        origin: bucket.subagent ? 'subagent' : null,
        running: bucket.running,
        runId: bucket.run?.runId ?? null,
        lastTurnEnd: bucket.run?.lastTurnEnd ?? null,
        toolCalls: bucket.run?.toolCalls ?? 0,
        lastTool: bucket.run?.lastTool ?? null,
        todoCount: bucket.run?.todoCount ?? 0,
        completedTodoCount: bucket.run?.completedTodoCount ?? 0,
        percent: percentOf(bucket.run),
        updatedAt: bucket.updatedAt,
        // Omitted, not `undefined`: the field is optional and a host that never
        // heard from a page must not look like one that heard "no read".
        ...(bucket.reader === null ? {} : { reader: bucket.reader }),
      })
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return rows
  }

  /** Whether any retained notice is still open. */
  hasOpenNotices(): boolean {
    for (const record of this.notices.values()) {
      if (record.state === 'pending' || record.state === 'shown') return true
    }
    return false
  }

  /** Settle one run into a completion and mark it consumed. */
  private settle(bucket: SessionState, run: RunState, at: number): RunCompletion {
    run.settled = true
    run.idlePendingSince = null
    bucket.running = false
    bucket.updatedAt = at
    this.revision += 1
    const last = run.lastTurnEnd
    return {
      sessionId: bucket.sessionId,
      runId: run.runId,
      // No reason at all is *not* a success. Every live path settles only when
      // `last` exists, so this is the defensive branch — and it still must not
      // claim "completed", which is the one outcome worth never guessing.
      reason: last?.kind ?? 'unknown',
      targetTurnRef: last === null ? null : String(last.turn),
      completedAt: at,
    }
  }

  /** Apply session facts; returns whether anything actually changed. */
  private applyFacts(bucket: SessionState, facts: SessionFacts): boolean {
    let changed = false
    if (facts.title !== undefined) {
      const next = clampTitle(facts.title) ?? null
      if (next !== bucket.title) {
        bucket.title = next
        changed = true
      }
    }
    if (facts.cwd !== undefined) {
      const next = facts.cwd === null ? null : (clampText(facts.cwd, 4096) ?? null)
      if (next !== bucket.cwd) {
        bucket.cwd = next
        changed = true
      }
    }
    if (facts.subagent !== undefined && facts.subagent !== bucket.subagent) {
      bucket.subagent = facts.subagent
      changed = true
    }
    if (facts.reader !== undefined && facts.reader !== bucket.reader) {
      bucket.reader = facts.reader
      changed = true
    }
    return changed
  }

  /** Look up or lazily create a session bucket. */
  private bucket(sessionId: string, at: number): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionState = {
      sessionId,
      title: null,
      cwd: null,
      subagent: false,
      removed: false,
      running: false,
      run: null,
      updatedAt: at,
      reader: null,
    }
    this.sessions.set(sessionId, created)
    return created
  }

  /**
   * Drop settled notices past the TTL, then trim to the size cap.
   *
   * Open notices are never evicted by age: an unacknowledged completion is
   * exactly the thing the pet exists to surface.
   *
   * @returns whether the notice table changed.
   */
  private expireNotices(at: number): boolean {
    let changed = false
    for (const [id, record] of this.notices) {
      if (record.state === 'pending' || record.state === 'shown') continue
      if (at - record.completedAt < this.options.noticeTtlMs) continue
      this.notices.delete(id)
      changed = true
    }
    if (this.notices.size > this.options.maxNotices) {
      const settled = [...this.notices.values()]
        .filter(record => record.state !== 'pending' && record.state !== 'shown')
        .sort((left, right) => left.completedAt - right.completedAt)
      for (const record of settled) {
        if (this.notices.size <= this.options.maxNotices) break
        this.notices.delete(record.noticeId)
        changed = true
      }
    }
    if (changed) this.revision += 1
    return changed
  }
}

/** Internal notice record; a superset of the exported snapshot. */
interface NoticeRecord {
  noticeId: string
  sessionId: string
  runId: string
  targetTurnRef: string | null
  reason: TurnEndKind
  completedAt: number
  state: NoticeState
  seenAt: number | null
  /** True once a completion event carrying this notice was handed to the pet. */
  delivered: boolean
  /** Whether that delivery already advertised `seen: true`. */
  deliveredSeen: boolean
  deliveredAt: number | null
}

/** Create a fresh, unsettled run record. */
function freshRun(runId: string, at: number): RunState {
  return {
    runId,
    startedAt: at,
    lastTurnEnd: null,
    idlePendingSince: null,
    settled: false,
    toolCalls: 0,
    lastTool: null,
    todoCount: 0,
    completedTodoCount: 0,
  }
}

/** Project the internal record onto the exported snapshot shape. */
function toSnapshot(record: NoticeRecord): NoticeSnapshot {
  return {
    noticeId: record.noticeId,
    sessionId: record.sessionId,
    runId: record.runId,
    targetTurnRef: record.targetTurnRef,
    reason: record.reason,
    completedAt: record.completedAt,
    state: record.state,
    seenAt: record.seenAt,
    delivered: record.delivered,
  }
}

/** Derived progress percentage, or null when the run has no todo list yet. */
function percentOf(run: RunState | null): number | null {
  if (run === null || run.todoCount <= 0) return null
  return Math.round((run.completedTodoCount / run.todoCount) * 100)
}

/**
 * Build a pet-facing event.
 *
 * Every field is either an identifier, a count, a bounded label, or a bounded
 * title. Raw tool arguments, prompts, assistant text, tool results, and
 * credentials have no field to travel in, by construction.
 *
 * @param input - identifiers plus optional bounded fields.
 * @returns a protocol-shaped event.
 */
export function buildEvent(input: {
  id: string
  event: PetEvent['event']
  hook: string
  sessionId: string
  runId?: string | null
  targetTurnRef?: string | null
  at: number
  title?: string | null
  message?: string
  tool?: string | null
  reason?: TurnEndKind
  seen?: boolean
  noticeId?: string
}): PetEvent {
  const event: PetEvent = {
    v: PROTOCOL_VERSION,
    id: input.id,
    event: input.event,
    source: 'deepseek-harness',
    hook: input.hook,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    targetTurnRef: input.targetTurnRef ?? null,
    timestamp: input.at,
    title: clampTitle(input.title) ?? null,
  }
  const message = clampText(input.message, MAX_MESSAGE_LENGTH)
  const tool = clampText(input.tool, 200)
  return {
    ...event,
    ...(message === undefined ? {} : { message }),
    ...(tool === undefined ? {} : { tool }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.seen === undefined ? {} : { seen: input.seen }),
    ...(input.noticeId === undefined ? {} : { noticeId: input.noticeId }),
  }
}
