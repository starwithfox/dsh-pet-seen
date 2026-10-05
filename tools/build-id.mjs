/**
 * The build identity shared by both halves of the plugin.
 *
 * **Why this exists** (the build handshake, PL-EN-NW-02). The plugin ships *two*
 * artifacts that load independently: `lib/index.js` (host half — only swapped by
 * restarting the host) and `client/client.js` (page half — reloaded with the
 * page). Nothing tied them together, so a half-refreshed install produced a
 * **silent mixture**. That is not hypothetical: on 2026-10-02 the `web` profile
 * ran a host half that had the drift self-check next to a client half that
 * predated it, and every gate stayed
 * green while that self-check (PL-EN-NW-06) was dead. One step
 * further (a host that sends a field the old client does not, or a client that
 * calls a route the old host does not have) is the original bug of this round:
 * no `/notices` request at all, no popup retraction, and a healthy-looking host.
 *
 * The identity is the `package.json` `version` plus the contents of every file
 * under `src/`, hashed to 16 hex characters. Both halves are given the same
 * value at build time (`tsdown.config.ts` passes it through `define`), so "are
 * these two halves the same build?" becomes a string comparison instead of an
 * inspection.
 *
 * It is deliberately **content-derived** rather than a hand-bumped constant or
 * a commit id:
 *
 * - a constant relies on remembering to change it — the exact "remembering is
 *   not a mechanism" failure this project keeps re-learning;
 * - a commit id misses a dirty worktree build, and `npm pack` / registry
 *   builds have no `.git` at all;
 * - a content hash also catches the *documented* shape "`link:` + rebuilt but
 *   host not restarted" (IS-001), where both halves share one
 *   commit and one version number.
 *
 * The value is deterministic: identical sources and version produce an
 * identical id, so the build stays byte-reproducible.
 *
 * Two consumers, one definition — `tsdown.config.ts` bakes it in and
 * `smoke-bundle.mjs` recomputes it to refuse artifacts that do not carry the id
 * of the sources they claim to come from.
 *
 * @module tools/build-id
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Every file under `<root>/src`, as `/`-separated paths relative to `root`,
 * sorted so the hash does not depend on directory order.
 *
 * @param root - package root (the directory holding `src/`).
 * @returns sorted relative paths.
 */
export function sourceFiles(root) {
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(join(root, 'src'))
  return found.sort()
}

/**
 * The `version` field of `<root>/package.json`, as the build records it.
 *
 * @param root - package root.
 * @returns the version string.
 */
export function readPluginVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

/**
 * Identity of the build described by `root`'s version and source tree.
 *
 * The version is hashed first, so a release bump alone changes the id: bumping
 * `package.json` without rebuilding then leaves artifacts that no longer carry
 * the id of their own sources, which is exactly what the bundle gate reports.
 *
 * @param root - package root.
 * @param version - override for the version, for tests and tooling.
 * @returns 16 hex characters.
 */
export function computeBuildId(root, version = readPluginVersion(root)) {
  const hash = createHash('sha256')
  hash.update(version)
  hash.update('\0')
  for (const file of sourceFiles(root)) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
