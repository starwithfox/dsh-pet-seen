/**
 * Gate C verdicts: the rules, kept apart from the observes.
 *
 * The driver owns the *sequence* (which tab is in front, when focus emulation is
 * on, when a popup is dismissed) because only the CDP side can do any of that.
 * The verdicts are derived here, from the raw observations the driver collected,
 * for the same reason the Gate A rules live page-side: a judgment that can only
 * be reached by running a whole browser twice is a judgment nobody re-checks, and
 * "the scenario was never established" keeps getting written down as "the product
 * failed" (ROUND 7's second live run did exactly that).
 *
 * Pure and DOM-free on purpose: it is loaded by `tools/cdp-acceptance.mjs`
 * through `evaluate()` and it is unit-tested by evaluating this same file in a
 * plain Node context. It must not touch `document`, timers, or the network.
 *
 * @module tools/gate-c-judge
 */

(() => {
  const JUDGE_VERSION = 'gate-c-judge-3'

  const PASS = 'PASS'
  const FAIL = 'FAIL'
  const SKIP = 'SKIP'
  const INCONCLUSIVE = 'INCONCLUSIVE'

  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null)

  /**
   * The reports this tab made for the target notice during one phase.
   *
   * The driver already asks the page for one notice's posts, so a record that
   * identifies no notice at all is still one of them; a record that *does* name a
   * notice has to name this one. Getting that backwards would let a report for
   * another notice pass as "no report" here.
   */
  const freshPosts = (phase, noticeId) => (phase.seenAfter ?? []).filter((post) => {
    if (typeof post.body === 'string') return post.body.indexOf(noticeId) !== -1
    if (typeof post.noticeId === 'string') return post.noticeId === noticeId
    return true
  })

  const refused = (posts) => posts.filter((post) => typeof post.status === 'number' && (post.status < 200 || post.status >= 300))
  const denied = (posts) => posts.filter((post) => post.accepted === false)

  /**
   * Did the host record an *observation* of the notice?
   *
   * Only `seen` counts. A notice moving from `pending` to `shown` is delivery —
   * the pet putting the popup on screen — and a move to `dismissed` is the user
   * closing it; neither is the page confirming that the result was read, so
   * neither may be read as an unwanted confirmation.
   */
  const advanced = (phase) => {
    const before = phase.hostBefore ?? {}
    const after = phase.hostAfter ?? {}
    if (after.state === 'seen') return true
    if (after.seenAt !== undefined && after.seenAt !== null && after.seenAt !== (before.seenAt ?? null)) return true
    return false
  }

  /**
   * Was the page actually watching *this* notice?
   *
   * The client walks the host's offer oldest-first and watches the first
   * candidate whose result is on screen (`selectWatchTarget`), so "the reply was
   * on screen and nothing was confirmed" is only a statement about the target
   * when the target was that candidate. The first live Gate C run judged a
   * positive phase whose reply was a 54 px sliver at the bottom of the band while
   * the page was watching an older reply that was genuinely on screen, and the
   * phase reported "no /seen" as a product failure. The driver now mirrors the
   * client's own rule page-side and records the answer; when the mirror names a
   * different notice, the scenario was never built and the verdict is
   * INCONCLUSIVE — never FAIL.
   */
  const watchMismatch = (phase) => {
    const held = phase.measured ?? {}
    if (held.watchPredictedNoticeId === undefined || held.watchPredictedNoticeId === null) return null
    if (held.watchPredictedNoticeId === phase.target?.noticeId) return null
    return {
      id: phase.id,
      verdict: INCONCLUSIVE,
      detail: `the page would have watched ${String(held.watchPredictedNoticeId)}`
        + ` (turn ${String(held.watchPredictedTurn)}), not ${String(phase.target?.noticeId)},`
        + ' so nothing about this notice was measured',
    }
  }

  const geometryLine = (phase) => {
    const held = phase.measured ?? {}
    const line = held.replyOnBand === true
      ? 'inside the band'
      : (held.replyOffBand === true ? 'strictly outside the band' : 'not measured')
    return `reply overlap: ${line} (measured ${num(held.groupOverlap)})`
  }

  /**
   * How long the phase *actually* held, rather than how long it was allowed to.
   *
   * `holdMs` is a ceiling, not a measurement. A positive phase stops the moment
   * its notice is confirmed — 326 ms and 647 ms into a 2 700 ms window in the
   * round-7 run — so printing the ceiling as the held time overstated the
   * evidence by 4–8x. The measured value is always preferred here; the ceiling is
   * only a fallback for observations recorded before the driver timed them.
   */
  const observed = (phase) => num(phase.heldMs) ?? num(phase.holdMs)

  /** `for 326 ms of the 2700 ms window (ended on confirmation)`. */
  const observationLine = (phase) => {
    const held = num(phase.heldMs)
    const window = num(phase.holdMs)
    const early = phase.settledEarly === true ? ' (ended on confirmation)' : ''
    if (held === null) return `for ${window} ms${early}`
    if (window === null || held >= window) return `for ${held} ms${early}`
    return `for ${held} ms of the ${window} ms window${early}`
  }

  /**
   * The confirmation timeline, when the driver recorded one.
   *
   * What the client needs is continuous *visible and focused* time. A phase that
   * confirms 326 ms into its hold has proved that the client confirmed the
   * notice; it has not proved that this phase watched it for a whole dwell,
   * because the rest of that dwell accrued while the reply was still being
   * staged. Both numbers are printed, and when the confirmation lands inside the
   * dwell the caveat says so, so nobody has to infer it from a raw `heldMs`.
   */
  const timelineLine = (phase) => {
    const line = phase.timeline ?? {}
    const into = num(line.seenAfterHoldStartMs)
    if (into === null) return ''
    const since = num(line.seenUpperBoundMs)
    const dwell = num(phase.dwellMs)
    const caveat = dwell !== null && into < dwell
      ? `; that is under the ${dwell} ms the client requires, so most of that dwell accrued while the reply`
        + ' was being staged — this phase proves the confirmation, not an independent in-band hold of that length'
      : ''
    return `; confirmed ${into} ms into the hold`
      + (since === null ? '' : `, at most ${since} ms after staging began`)
      + caveat
  }

  /**
   * A phase that must **not** confirm anything.
   *
   * Passing needs three things at once: the page was really in the state the
   * phase claims (hidden / blurred / looking at another turn), the notice was on
   * offer throughout, and neither this tab nor the host moved it. Any of the
   * first two missing is INCONCLUSIVE — never a pass, and never a failure blamed
   * on the product.
   */
  const judgeNegative = (phase) => {
    const id = phase.id
    const target = phase.target
    const posts = freshPosts(phase, target.noticeId)
    const expect = phase.expect ?? {}
    const held = phase.measured ?? {}

    if (phase.hostAfter?.offered === false) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the notice stopped being offered during the hold (state "${String(phase.hostAfter?.state)}"),`
          + ' so it was retired by something other than this measurement and the hold proves nothing',
      }
    }
    if (expect.focused === false && held.pageFocused === true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the page still reported focus (visibility "${String(held.pageVisible)}", focused=${String(held.pageFocused)}),`
          + ' so the blur this phase needs was never established — nothing was tested',
      }
    }
    if (expect.visible !== undefined && held.pageVisible !== expect.visible) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the page reported visibility "${String(held.pageVisible)}" where "${expect.visible}" was needed,`
          + ' so this phase did not exercise the state it is about',
      }
    }
    if (expect.replyOnBand === true && held.replyOnBand !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the reply was not on screen during the hold (${geometryLine(phase)}), so "visible but unobserved" was never built`,
      }
    }
    if (expect.replyOffBand === true && held.replyOffBand !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the reply was not strictly off the band during the hold (${geometryLine(phase)}), so the counterexample geometry was lost`,
      }
    }
    if (expect.otherTurnOnBand === true && held.otherTurnOnBand !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: 'no other turn\'s reply was on screen during the hold, so "the notice points at a turn that is not the'
          + ' one being read" was never built',
      }
    }
    const watching = watchMismatch(phase)
    if (expect.watched === true && watching !== null) return watching
    /*
     * Only a *visible* target can be dwelt on. A notice whose turn has no rendered
     * result is the fallback candidate the client watches without ever
     * accumulating dwell, so finding it here does not weaken the mismatch this
     * phase is about: the notice's own result is still not the one on screen.
     */
    if (expect.watched === false && held.watchPredictedNoticeId === target.noticeId && held.watchPredictedVisible === true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the page was watching the very notice this phase judges (${String(target.noticeId)}) and its result was`
          + ' on screen, so the mismatch it needs — notice pointing at one turn, another turn being read — was never built',
      }
    }
    if (Array.isArray(phase.scoping?.otherSessionOfferNoticeIds)
      && phase.scoping.otherSessionOfferNoticeIds.includes(target.noticeId)) {
      return {
        id,
        verdict: FAIL,
        detail: `the host offered ${String(target.noticeId)} to the other session's page, so a notice leaked across sessions`,
      }
    }
    if (posts.length > 0) {
      return {
        id,
        verdict: FAIL,
        detail: `this tab posted /seen for the notice while ${String(phase.title)}:`
          + ` ${posts.length} report(s) (HTTP ${posts.map((post) => String(post.status ?? '?')).join(', ')}),`
          + ` host state "${String(phase.hostBefore?.state)}" -> "${String(phase.hostAfter?.state)}"`
          + ` after ${observed(phase)} ms of "${String(held.pageVisible)}"/focused=${String(held.pageFocused)}`,
      }
    }
    if (advanced(phase)) {
      return {
        id,
        verdict: FAIL,
        detail: `the host moved the notice (state "${String(phase.hostBefore?.state)}" -> "${String(phase.hostAfter?.state)}",`
          + ` seenAt ${String(phase.hostBefore?.seenAt ?? null)} -> ${String(phase.hostAfter?.seenAt ?? null)})`
          + ' although this tab never reported it',
      }
    }
    return {
      id,
      verdict: PASS,
      detail: `offered throughout and unconfirmed after ${observed(phase)} ms with`
        + ` visibility "${String(held.pageVisible)}", focused=${String(held.pageFocused)},`
        + ` ${geometryLine(phase)}: new /seen=0, host state stayed "${String(phase.hostAfter?.state)}"`,
    }
  }

  /**
   * A phase that **must** confirm: the reply on screen, in focus, for the dwell.
   *
   * The report and the acceptance are kept apart — "the page posted" is the
   * page's claim, "the host accepted" is what makes it an observation, and the
   * notice leaving the offer is the terminal state the plan asks for.
   */
  const judgePositive = (phase) => {
    const id = phase.id
    const target = phase.target
    const posts = freshPosts(phase, target.noticeId)
    const held = phase.measured ?? {}

    if (held.pageVisible !== 'visible' || held.pageFocused !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the page was not visible and focused during the hold`
          + ` (visibility "${String(held.pageVisible)}", focused=${String(held.pageFocused)}),`
          + ` so the dwell could not run (new /seen posts=${posts.length})`,
      }
    }
    if (held.replyOnBand !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the reply was not inside the band during the hold (${geometryLine(phase)}), so there was nothing to observe`,
      }
    }
    const watching = watchMismatch(phase)
    if (watching !== null) return watching
    if (held.watchPredictedVisible === false) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: 'the page\'s own offer, read back after the park, had no visible candidate, so the dwell this phase'
          + ' needs never had a subject',
      }
    }
    if (refused(posts).length > 0) {
      return {
        id,
        verdict: FAIL,
        detail: `this tab posted /seen and the host refused it: HTTP ${refused(posts).map((post) => String(post.status)).join(', ')}`,
      }
    }
    if (denied(posts).length > 0) {
      return {
        id,
        verdict: FAIL,
        detail: 'this tab posted /seen and the host answered accepted=false, so the observation was thrown away',
      }
    }
    if (posts.length > 0 && phase.hostAfter?.offered === false) {
      const unchanged = phase.alsoUnchanged ?? []
      if (unchanged.length > 0) {
        const moved = unchanged.filter((entry) => entry.offered === false)
        if (moved.length > 0) {
          return {
            id,
            verdict: FAIL,
            detail: `confirming ${String(target.noticeId)} also retired ${moved.map((entry) => String(entry.noticeId)).join(', ')},`
              + ' so one result confirmed a notice that points at another turn',
          }
        }
      }
      return {
        id,
        verdict: PASS,
        detail: `reply inside the band at visibility "visible"/focused=true ${observationLine(phase)}:`
          + ` new /seen posts=${posts.length} (HTTP ${posts.map((post) => String(post.status ?? '?')).join(', ')}),`
          + ` notice "${String(phase.hostBefore?.state)}" is no longer offered`
          + (unchanged.length > 0
            ? `; ${unchanged.map((entry) => `${String(entry.noticeId)} stayed offered`).join(', ')}`
            : '')
          + timelineLine(phase),
      }
    }
    if (posts.length > 0) {
      return {
        id,
        verdict: FAIL,
        detail: `this tab posted /seen ${posts.length} time(s) but the notice is still offered`
          + ` (state "${String(phase.hostAfter?.state)}"), so the host did not act on the observation`,
      }
    }
    if (phase.hostAfter?.offered === false) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: 'no report came from this tab, yet the notice stopped being offered: another consumer retired it,'
          + ' which says nothing about this page\'s dwell',
      }
    }
    return {
      id,
      verdict: FAIL,
      detail: `reply inside the band ${observationLine(phase)} in focus: new /seen posts=0 and the notice is still`
        + ` offered (state "${String(phase.hostAfter?.state)}")`,
    }
  }

  /**
   * A popup the user closed: looking at the result again must not confirm it and
   * must not bring the popup back.
   */
  const judgeDismissed = (phase) => {
    const id = phase.id
    const target = phase.target
    const posts = freshPosts(phase, target.noticeId)
    const held = phase.measured ?? {}
    if (phase.hostAfter?.state !== 'dismissed') {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the notice is in state "${String(phase.hostAfter?.state)}" after the pet's manual close,`
          + ' so the "after dismissal" state was never established',
      }
    }
    if (held.replyOnBand !== true) {
      return {
        id,
        verdict: INCONCLUSIVE,
        detail: `the reply was not back inside the band (${geometryLine(phase)}), so the user never looked at the`
          + ' closed notice\'s result again and the phase proves nothing',
      }
    }
    if (posts.length > 0) {
      return {
        id,
        verdict: FAIL,
        detail: `the page reported /seen ${posts.length} time(s) for a notice the user had already closed`
          + ` (HTTP ${posts.map((post) => String(post.status ?? '?')).join(', ')})`,
      }
    }
    if (phase.hostAfter?.rebuilt === true) {
      return {
        id,
        verdict: FAIL,
        detail: 'the popup was pushed to the pet again after the user closed it',
      }
    }
    return {
      id,
      verdict: PASS,
      detail: `the reply was back inside the band ${observationLine(phase)} with the notice "${String(phase.hostAfter?.state)}":`
        + ' no /seen, still not offered'
        + (phase.hostAfter?.rebuilt === null || phase.hostAfter?.rebuilt === undefined
          ? '; whether the pet was pushed a second popup is not visible from the page — see the pet log'
          : ' and no second popup push'),
    }
  }

  /**
   * Judge every phase and return the checks, in the order the phases ran.
   *
   * @param observations - `{ target, phases }` as collected by the driver.
   * @returns `[{ id, verdict, detail }]`.
   */
  const judge = (observations) => {
    const phases = Array.isArray(observations?.phases) ? observations.phases : []
    return phases.map((phase) => {
      const withTarget = {
        ...phase,
        target: phase.target ?? observations.target,
        dwellMs: observations.dwellMs,
      }
      if (phase.kind === 'positive') return judgePositive(withTarget)
      if (phase.kind === 'dismissed') return judgeDismissed(withTarget)
      if (phase.kind === 'negative') return judgeNegative(withTarget)
      return { id: phase.id, verdict: SKIP, detail: `unknown phase kind "${String(phase.kind)}"` }
    })
  }

  const api = { version: JUDGE_VERSION, judge, PASS, FAIL, SKIP, INCONCLUSIVE }
  if (typeof window !== 'undefined') window.__petGateCJudge = api
  if (typeof globalThis !== 'undefined') globalThis.__petGateCJudge = api
})()
