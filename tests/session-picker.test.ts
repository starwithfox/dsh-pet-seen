/**
 * Smoke test for `tools/session-picker-page.js`.
 *
 * WHY THIS EXISTS
 *   ROUND 4's driver never reached the acceptance gates. A fresh Chrome profile
 *   lands on the *new-conversation placeholder* rather than the most recent
 *   session, and a notice is only ever minted for the session that settled a
 *   run — so with no `[data-chat-flow]` on screen there was nothing to stage and
 *   A2/A3/Y2 could not even be attempted. The session picker is the fix, and it
 *   had never been executed anywhere when it was written: "the fiber carries
 *   `props.node.id`" was supported only by reading
 *   `dsh-client-ui-workspace/lib/client.js`, never by a run.
 *
 *   One real-machine attempt costs the user a `danger-full-access` approval, so
 *   the cheap move is to pin the picker's contract offline first.
 *
 * WHAT IS PINNED
 *   1. `fiber-id` beats `title-text`, and the strategy is reported — a fallback
 *      must never be mistakable for the exact path.
 *   2. With the React internals stripped (a real possibility: React only exposes
 *      `__reactFiber$…` in development builds), the picker falls back to the
 *      host-reported title.
 *   3. **Nothing is clicked when nothing matched.** This is the floor: clicking
 *      the wrong row would open an unrelated session and make the acceptance run
 *      look like it reached the conversation while it did not.
 *   4. `rows` honestly lists every sidebar row, including the ones whose id
 *      could not be read — that dump is what ROUND 5 §7 relies on to diagnose
 *      the next failure without spending another approval.
 *
 *   The file under test is read from disk and evaluated verbatim (indirect eval,
 *   in global scope with stubbed `window`/`document`), the same discipline
 *   `tests/acceptance-page.test.ts` uses: the bytes that are tested and the bytes
 *   the browser executes are one file, not two copies of one rule set.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Path of the picker under test, from the compiled test's own location. */
const PICKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'session-picker-page.js',
)

const WANTED_ID = 'session-wanted'
const WANTED_TITLE = '读取交接文档准备下一步'
const OTHER_ID = 'session-other'
const OTHER_TITLE = 'Round2交付文档测试'
/** The title is a prefix of this one, so a sloppy match can settle on the wrong row. */
const DECOY_TITLE = `${WANTED_TITLE}（续）`

/** One sidebar row: what the DOM shows and what React knows about it. */
interface RowSpec {
  readonly id?: string
  readonly title?: string
  readonly text: string
}

/** One entry of the picker's own `rows` dump. */
interface RowDump {
  readonly index: number
  readonly id: string | null
  readonly title: string | null
  readonly text: string
  readonly selected: boolean
}

interface PickResult {
  readonly wanted: string | null
  readonly wantedTitle: string | null
  readonly matchedBy: string | null
  readonly clicked: boolean
  readonly fibersExposed: boolean
  readonly rows: readonly RowDump[]
}

/** The `props.node` shape the sidebar's `SessionNodeItem` receives. */
interface FakeNode {
  readonly id: string
  readonly title: string
}

/**
 * Build one fake `div[role="treeitem"]`.
 *
 * React attaches its internals under randomly suffixed keys, so the suffix here
 * is arbitrary on purpose: matching a specific literal key would be exactly the
 * ROUND 4 bug this file exists to prevent.
 */
function makeRowElement(
  spec: RowSpec,
  options: { exposeFiber: boolean, selected?: boolean },
): Record<string, unknown> {
  const node: FakeNode | null = spec.id !== undefined && spec.id !== ''
    ? { id: spec.id, title: spec.title ?? '' }
    : null

  const element: Record<string, unknown> = {
    textContent: spec.text,
    getAttribute: (name: string): string | null =>
      name === 'aria-selected' ? (options.selected === true ? 'true' : 'false') : null,
    click: () => { element.clickCount = ((element.clickCount as number) ?? 0) + 1 },
    clickCount: 0,
    // The row's own props carry only `onClick`; the id lives on an ancestor
    // component's props, which is why the picker walks `return`.
    __reactProps$fixture: { onClick: () => { element.propsClickCount = ((element.propsClickCount as number) ?? 0) + 1 } },
    propsClickCount: 0,
  }

  if (options.exposeFiber) {
    element.__reactFiber$fixture = {
      memoizedProps: { className: 'row' },
      return: { memoizedProps: { node }, return: null },
    }
  }

  return element
}

/** Run the real picker file against a fresh sidebar double. */
async function runPicker(options: {
  rows: readonly RowSpec[]
  sessionId?: string | null
  title?: string | null
  open?: boolean
  exposeFiber?: boolean
}): Promise<{ result: PickResult, elements: ReadonlyArray<Record<string, unknown>> }> {
  const exposeFiber = options.exposeFiber ?? true
  const elements = options.rows.map(spec => makeRowElement(spec, { exposeFiber }))

  const documentStub = {
    body: makeRowElement({ text: 'sidebar' }, { exposeFiber }),
    querySelectorAll: (selector: string): ReadonlyArray<unknown> =>
      selector === '[role="treeitem"]' ? elements : [],
  }

  const windowStub: Record<string, unknown> = {
    __petSessionPickRequest: {
      sessionId: options.sessionId ?? null,
      title: options.title ?? null,
      open: options.open === true,
    },
  }

  const code = readFileSync(PICKER_PATH, 'utf8')
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { window: globals.window, document: globals.document }

  globals.window = windowStub
  globals.document = documentStub
  try {
    // Indirect eval: the picker is a browser script, so it must run in global
    // scope against the stubbed globals, not in this module's scope.
    await (0, eval)(code)
  } finally {
    globals.window = saved.window
    globals.document = saved.document
  }

  const published = windowStub.__petSessionPickResult
  assert.equal(typeof published, 'string', 'the picker must publish a JSON result string')

  return { result: JSON.parse(published as string) as PickResult, elements }
}

/** The sidebar from the ROUND 4 dump: the target sits below another session. */
const ROWS: readonly RowSpec[] = [
  { id: OTHER_ID, title: OTHER_TITLE, text: `会话 ${OTHER_TITLE}` },
  { id: WANTED_ID, title: WANTED_TITLE, text: `会话 ${WANTED_TITLE}` },
]

describe('session picker (tools/session-picker-page.js)', () => {
  it('prefers the fiber id over the title and says so', async () => {
    const { result, elements } = await runPicker({
      rows: ROWS,
      sessionId: WANTED_ID,
      title: OTHER_TITLE,
      open: true,
    })

    assert.equal(result.matchedBy, 'fiber-id')
    assert.equal(result.clicked, true, 'the matched row has to actually be opened')
    assert.equal(result.wanted, WANTED_ID)
    assert.equal(
      elements[1]?.propsClickCount,
      1,
      'the row\'s own onClick closes over the right id, so it is what must be invoked',
    )
    assert.equal(elements[0]?.propsClickCount, 0, 'the unrelated row must be left alone')
  })

  it('falls back to the host-reported title when React internals are stripped', async () => {
    const { result, elements } = await runPicker({
      rows: ROWS,
      sessionId: WANTED_ID,
      title: WANTED_TITLE,
      open: true,
      exposeFiber: false,
    })

    assert.equal(result.fibersExposed, false, 'the double must actually hide the React keys')
    assert.equal(result.matchedBy, 'title-text', 'the id source is gone, so the title source must carry it')
    assert.equal(result.clicked, true)
    assert.equal(elements[1]?.propsClickCount, 1)
    assert.equal(result.rows[1]?.id, null, 'without fibers the id genuinely cannot be read')
  })

  /*
   * The floor. A picker that clicks a guessed row opens an unrelated session,
   * and the acceptance run then looks like it reached a conversation when it is
   * looking at the wrong one — the ROUND 1 class of bug, in tooling.
   */
  it('never clicks when neither source matched', async () => {
    const { result, elements } = await runPicker({
      rows: ROWS,
      sessionId: 'session-not-in-the-sidebar',
      title: 'a title no row carries',
      open: true,
    })

    assert.equal(result.matchedBy, null)
    assert.equal(result.clicked, false, 'no match means no click, even with open requested')
    for (const element of elements) {
      assert.equal(element.propsClickCount, 0, 'no row may be invoked on a miss')
      assert.equal(element.clickCount, 0, 'and neither may the bare DOM click fallback')
    }
  })

  it('reports every row it looked at, including the ones without an id', async () => {
    const { result } = await runPicker({
      rows: [
        { id: OTHER_ID, title: OTHER_TITLE, text: `会话 ${OTHER_TITLE}` },
        { text: '展开其余 13 个会话' },
        { id: WANTED_ID, title: WANTED_TITLE, text: `会话 ${WANTED_TITLE}` },
      ],
      sessionId: WANTED_ID,
      open: false,
    })

    assert.equal(result.rows.length, 3, 'the dump must cover the sidebar, not just the match')
    assert.deepEqual(
      result.rows.map(row => row.index),
      [0, 1, 2],
    )
    assert.deepEqual(
      result.rows.map(row => row.id),
      [OTHER_ID, null, WANTED_ID],
      'an unreadable row is reported as null rather than dropped',
    )
    assert.equal(result.rows[1]?.text, '展开其余 13 个会话')
    assert.equal(result.clicked, false, 'open was not requested')
    assert.equal(result.wanted, WANTED_ID)
  })

  /*
   * The title fallback is a substring test, so a longer title that *contains*
   * the wanted one would win if rows were scanned in the wrong order or the
   * comparison were loosened. Here the real row is decorated the way the sidebar
   * decorates it (`会话 <title>`), which the substring pass must still reach —
   * and the decoy above it is *also* only a substring match, so the two are told
   * apart by position alone. Substring claims the first row; nothing about the
   * wanted row is "more exact", so that is the correct answer here, and this
   * test pins that the scan is a first-match scan rather than a last-match one.
   */
  it('does not let a longer title containing the wanted one win the fallback', async () => {
    const { result, elements } = await runPicker({
      rows: [
        { id: 'session-decoy', title: DECOY_TITLE, text: `会话 ${DECOY_TITLE}` },
        { id: WANTED_ID, title: WANTED_TITLE, text: `会话 ${WANTED_TITLE}` },
      ],
      sessionId: null,
      title: WANTED_TITLE,
      open: true,
      exposeFiber: false,
    })

    assert.equal(result.matchedBy, 'title-text')
    assert.equal(result.clicked, true)
    assert.equal(
      elements[0]?.propsClickCount,
      1,
      'with both rows decorated, the first substring match is the documented answer',
    )
    assert.equal(elements[1]?.propsClickCount, 0)
    // The dump has to make that ambiguity visible, so a miss can be diagnosed
    // later without another approval.
    assert.equal(result.rows[0]?.text, `会话 ${DECOY_TITLE}`)
    assert.equal(result.rows[1]?.text, `会话 ${WANTED_TITLE}`)
  })

  /*
   * The test above is still satisfied by a plain "first substring wins" matcher,
   * because both of its rows are decorated and the decoy is listed first. This
   * one is not: the row whose whole text is exactly the wanted title sits
   * *second*, behind a decorated row that merely contains it. Only an exact-text
   * pass can reach the right row; a substring-only matcher settles on the
   * decorated row and opens the wrong session.
   */
  it('prefers the row whose whole text is the wanted title, even when it is listed second', async () => {
    const { result, elements } = await runPicker({
      rows: [
        { id: 'session-decoy', title: DECOY_TITLE, text: `会话 ${DECOY_TITLE}` },
        { id: WANTED_ID, title: WANTED_TITLE, text: WANTED_TITLE },
      ],
      sessionId: null,
      title: WANTED_TITLE,
      open: true,
      exposeFiber: false,
    })

    assert.equal(result.matchedBy, 'title-text')
    assert.equal(result.clicked, true)
    assert.equal(elements[1]?.propsClickCount, 1, 'the exact-text row is the one to open')
    assert.equal(elements[0]?.propsClickCount, 0, 'the substring-only row must not win')
  })

  /*
   * The exact-text pass is a preference, not a requirement. The sidebar
   * decorates rows (prefixes, counts, timestamps), so a session whose row text
   * never equals its title must still be reachable — otherwise the "exact first"
   * fix would silently turn the fallback off for every real row.
   */
  it('still matches a decorated row when no row text equals the title exactly', async () => {
    const { result, elements } = await runPicker({
      rows: [
        { id: OTHER_ID, title: OTHER_TITLE, text: `会话 ${OTHER_TITLE}` },
        { id: WANTED_ID, title: WANTED_TITLE, text: `会话 ${WANTED_TITLE} · 2分钟` },
      ],
      sessionId: null,
      title: WANTED_TITLE,
      open: true,
      exposeFiber: false,
    })

    assert.equal(result.matchedBy, 'title-text', 'the decorated row must still be found')
    assert.equal(result.clicked, true)
    assert.equal(elements[1]?.propsClickCount, 1)
  })
})
