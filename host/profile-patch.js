/**
 * Profile-patch writer for the MCP manager.
 *
 * `ctx.configEditor` can rewrite the `config` of an existing row, but it cannot
 * add or delete a row. MCP servers are added and removed, so this file owns the
 * two operations `configEditor` lacks: it reads the profile patch, applies the
 * document edit from `./patch-doc.js` under the same HMR lock and file lock the
 * other profile writers use, writes the result atomically, then lets
 * `reconcileProfilePatches` recompose the Loader. A failed reconcile restores
 * the previous bytes.
 *
 * @module dsh-mcp-servers
 */
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isDeepStrictEqual } from 'node:util'
import { hasInsertedRow, hasLiteralExpressionMap, insertRow, parsePatch, removeRow, serializePatch } from './patch-doc.js'

/** Bin name the profile helpers expect. */
const BIN = 'dsh'

/** Package that owns the Loader reconcile path this writer must share. */
const APP_BOOT = '@deepseek-ai/dsh-app-boot'

/** Resolved `dsh-app-boot` instance, shared by every write in this process. */
let hostAppBoot

/**
 * Import the `dsh-app-boot` copy the running host itself imported.
 *
 * `reconcileProfilePatches` finds the root Include through a module-level
 * WeakMap keyed by the booted `ctx`. That map is per module instance, so a
 * second copy of the package (the one npm would install under this plugin)
 * has an empty map and throws `profile reload requires the root Include entry`
 * on every write. Resolving the package from the host's own installation
 * anchor — the same anchor the Loader uses for bare plugin names — yields the
 * exact module the host booted with, so the map is the host's.
 *
 * @param {string | undefined} installAnchor Absolute path of the dsh app's `package.json`.
 * @returns {Promise<typeof import('@deepseek-ai/dsh-app-boot')>} The host's module.
 */
async function appBoot(installAnchor) {
  if (hostAppBoot !== undefined) return hostAppBoot
  let specifier
  if (typeof installAnchor === 'string' && installAnchor !== '') {
    // `resolve` walks the anchor's node_modules chain, which is the same lookup
    // the Loader performs for the host's own imports; a file URL then makes the
    // ESM cache hand back the instance the host already evaluated.
    try {
      specifier = pathToFileURL(createRequire(installAnchor).resolve(APP_BOOT)).href
    } catch {
      specifier = undefined
    }
  }
  // Bare fallback for a host that exposes no anchor (tests, embedders). It can
  // only ever find a second copy, so the reconcile call still fails loud.
  hostAppBoot = await import(specifier ?? APP_BOOT)
  return hostAppBoot
}

/**
 * Build the patch writer.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context that owns the profile.
 * @returns {{ insertMany: (rows: object[]) => Promise<void>, remove: (row: object) => Promise<void> }}
 */
function createProfilePatchWriter(ctx) {
  const profile = ctx.profileContext
  if (profile === undefined) throw new Error('mcp-manager: this composition has no profile context')

  async function readPatch() {
    try {
      if (!(await lstat(profile.patchPath)).isFile()) throw new Error('MCP management requires a regular profile patch file')
      return await readFile(profile.patchPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return undefined
    }
  }

  function flatten(rows) {
    return rows.flatMap((row) => row.group && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row])
  }

  async function exclusive(change, removedId) {
    const run = () => withFileLock(join(profile.dir, 'package.json'), async () => {
      const before = await readPatch()
      const document = parsePatch(before?.toString() ?? '')
      const { loadProfileDirectory, readProfilePatches, composeEntries, reconcileProfilePatches } = await appBoot(profile.installAnchor)
      const loaded = loadProfileDirectory(BIN, profile.dir, profile.installAnchor, { userLayer: false })
      const patchesFor = (text) => readProfilePatches(BIN, profile, { ...loaded, patches: parsePatch(text, true).toJS() })
      const previousPatches = patchesFor(before?.toString() ?? '')
      const previousRows = flatten(composeEntries([previousPatches]))
      const verify = change(document, previousRows)
      const text = serializePatch(document)
      const patches = patchesFor(text)
      const requiredIds = verify(flatten(composeEntries([patches])))
      if (!isDeepStrictEqual(await readPatch(), before)) throw new Error('Profile patch changed during the operation; retry after refreshing')
      await writeFileAtomic(profile.patchPath, text, { mode: 0o600 })
      try {
        await reconcileProfilePatches(ctx.root, patches, BIN, requiredIds)
        const mounted = [...ctx.root.loader.entries()]
        for (const id of requiredIds) {
          const matches = mounted.filter((entry) => entry.options.id === id)
          if (matches.length !== 1 || matches[0].disabled) throw new Error(`MCP row "${id}" did not load after the profile write`)
        }
        if (removedId !== undefined && mounted.some((entry) => entry.options.id === removedId)) {
          throw new Error(`MCP row "${removedId}" remains loaded after removal`)
        }
      } catch (error) {
        try {
          if (!isDeepStrictEqual(await readPatch(), Buffer.from(text))) throw new Error('profile patch changed after the write')
          if (before === undefined) await unlink(profile.patchPath)
          else await writeFileAtomic(profile.patchPath, before, { mode: 0o600 })
        } catch (rollback) {
          throw new Error(`${error.message}; restoring the profile file failed: ${rollback.message}`, { cause: error })
        }
        try {
          await reconcileProfilePatches(ctx.root, previousPatches, BIN)
        } catch (rollback) {
          throw new Error(`${error.message}; restoring the running profile failed: ${rollback.message}`, { cause: error })
        }
        throw error
      }
    })
    const hmr = ctx.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  return {
    assertSafeConfigEdit() {
      try {
        if (!lstatSync(profile.patchPath).isFile()) throw new Error('MCP management requires a regular profile patch file')
        const document = parsePatch(readFileSync(profile.patchPath, 'utf8'))
        if (hasLiteralExpressionMap(document)) {
          throw new Error('This DSH configuration editor would rewrite a literal __jsExpr map. Edit the profile patch directly to preserve it.')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    },
    async removableRows(rows) {
      try {
        const document = parsePatch((await readPatch())?.toString() ?? '')
        return new Set(rows.filter((row) => hasInsertedRow(document, row)).map((row) => row.id))
      } catch {
        return new Set()
      }
    },
    /** Append a whole batch, checking names again after entering the lock. */
    insertMany(rows) {
      return exclusive((document, previousRows) => {
        const names = new Set()
        for (const row of [...previousRows, ...[...ctx.loader.entries()].map((entry) => entry.options)]) {
          if (row.name === rows[0]?.name) names.add(row.config?.serverName)
        }
        for (const row of rows) {
          const name = row.config.serverName
          if (names.has(name)) {
            throw Object.assign(new Error(`MCP server "${name}" already exists`), {
              code: 'invalid', importIssue: { kind: 'duplicate-server', params: { serverName: name } },
            })
          }
          names.add(name)
        }
        for (const row of rows) insertRow(document, row)
        return (effective) => rows.map((row) => {
          const matches = effective.filter((item) => item.id === row.id)
          if (matches.length !== 1 || matches[0].name !== row.name || matches[0].disabled ||
            !isDeepStrictEqual(matches[0].config, row.config)) {
            throw new Error(`MCP server "${row.config.serverName}" is overridden by another configuration layer`)
          }
          return row.id
        })
      })
    },
    /** Remove one plugin row from the profile patch. */
    remove(row) {
      return exclusive((document, previousRows) => {
        const matches = previousRows.filter((item) => item.id === row.id)
        if (matches.length !== 1 || matches[0].name !== row.name || !isDeepStrictEqual(matches[0].config, row.config)) {
          throw new Error(`MCP row "${row.id}" changed or is not uniquely owned by this profile`)
        }
        removeRow(document, row)
        return (effective) => {
          if (effective.some((item) => item.id === row.id)) throw new Error(`MCP row "${row.id}" still exists in another layer`)
          return []
        }
      }, row.id)
    },
  }
}

export { createProfilePatchWriter }
